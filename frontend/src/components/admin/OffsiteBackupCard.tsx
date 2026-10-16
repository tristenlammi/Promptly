import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, CloudUpload, Loader2 } from "lucide-react";

import {
  adminApi,
  type BackupRun,
  type OffsiteOverview,
  type OffsiteTargetKind,
  type OffsiteUpdatePayload,
} from "@/api/admin";
import { extractError, formatRelativeTime, humanSize } from "@/components/files/helpers";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

const TARGETS: { value: OffsiteTargetKind; label: string; hint: string }[] = [
  { value: "folder", label: "USB disk or NAS folder", hint: "A disk or share mounted on this machine (OFFSITE_BACKUP_DIR in .env)." },
  { value: "s3", label: "S3 / Backblaze B2", hint: "Any S3-compatible bucket: AWS, Backblaze B2, Wasabi, MinIO…" },
  { value: "sftp", label: "Another computer (SFTP)", hint: "A NAS or a friend's machine you can reach over SSH." },
  { value: "rest", label: "restic rest-server", hint: "Best run with --append-only, so this server can't delete its own copies." },
];

const LOCATION: Record<OffsiteTargetKind, { label: string; placeholder: string }> = {
  folder: { label: "Folder inside the mounted disk", placeholder: "promptly" },
  s3: { label: "Endpoint / bucket / folder", placeholder: "s3.us-west-002.backblazeb2.com/my-bucket/promptly" },
  sftp: { label: "user@host:/path", placeholder: "backup@nas.lan:/volume1/promptly" },
  rest: { label: "rest-server URL", placeholder: "https://backup.example.com:8000/promptly" },
};

const CREDENTIALS: Record<OffsiteTargetKind, { key: string; label: string; secret?: boolean; multiline?: boolean }[]> = {
  folder: [],
  s3: [
    { key: "access_key_id", label: "Access key ID (B2: key ID)" },
    { key: "secret_access_key", label: "Secret access key (B2: application key)", secret: true },
    { key: "region", label: "Region (optional)" },
  ],
  sftp: [{ key: "private_key", label: "SSH private key", secret: true, multiline: true }],
  rest: [
    { key: "username", label: "Username (optional)" },
    { key: "password", label: "Password", secret: true },
  ],
};

/**
 * Off-site backup (WP-2.3, D11). The dumps above live on this machine; a
 * failed disk or a stolen box takes them too. This sends encrypted copies
 * of the database, files and config to a target the admin chooses, checks
 * them weekly, and test-restores monthly.
 */
export function OffsiteBackupCard({ offsite }: { offsite: OffsiteOverview }) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<OffsiteTargetKind>(offsite.target_kind);
  const [location, setLocation] = useState(offsite.location);
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [hour, setHour] = useState(offsite.hour);
  const [restoreTest, setRestoreTest] = useState(offsite.restore_test_enabled);
  // Shown straight away; the server's answer settles it.
  const [enabled, setEnabled] = useState(offsite.enabled);
  useEffect(() => setEnabled(offsite.enabled), [offsite.enabled]);
  const [testResult, setTestResult] = useState<string | null>(null);

  useEffect(() => {
    setKind(offsite.target_kind);
    setLocation(offsite.location);
    setHour(offsite.hour);
    setRestoreTest(offsite.restore_test_enabled);
  }, [offsite.target_kind, offsite.location, offsite.hour, offsite.restore_test_enabled]);

  const refresh = () => void qc.invalidateQueries({ queryKey: ["admin", "backups"] });
  const save = useMutation({
    mutationFn: (patch: OffsiteUpdatePayload) => adminApi.updateOffsite(patch),
    onSuccess: () => {
      setCreds({});
      refresh();
    },
    onError: (e) => toast.error(extractError(e)),
  });
  const test = useMutation({
    mutationFn: adminApi.testOffsite,
    onSuccess: (r) =>
      setTestResult(
        r.ok
          ? r.created
            ? "Connected — a new, empty backup store was created there."
            : `Connected — ${r.snapshots} cop${r.snapshots === 1 ? "y" : "ies"} there${r.latest ? `, latest ${formatRelativeTime(r.latest)}` : ""}.`
          : `Couldn't use it: ${r.error}`
      ),
    onError: (e) => setTestResult(extractError(e)),
  });
  const action = useMutation({
    mutationFn: (a: "run" | "check" | "restore-test") => adminApi.offsiteAction(a),
    onSuccess: (_d, a) => {
      toast.success(a === "run" ? "Off-site copy started" : a === "check" ? "Check started" : "Trial restore started");
      refresh();
    },
    onError: (e) => toast.error(extractError(e)),
  });

  const settingsPatch = (): OffsiteUpdatePayload => ({
    target_kind: kind,
    location,
    hour,
    restore_test_enabled: restoreTest,
    ...(Object.keys(creds).length ? { credentials: creds } : {}),
  });
  const saveAndTest = async () => {
    setTestResult(null);
    await save.mutateAsync(settingsPatch());
    test.mutate();
  };

  const running =
    [offsite.last_copy, offsite.last_check, offsite.last_restore_test].some((r) => r?.status === "running");
  const ok = offsite.last_copy_ok;

  return (
    <section className="space-y-4 rounded-card border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex items-start gap-3">
        <CloudUpload className="mt-0.5 h-5 w-5 shrink-0 text-[var(--text-muted)]" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-[var(--text)]">Off-site backup</h3>
          <p className="mt-0.5 text-xs text-[var(--text-muted)]">
            Encrypted copies of the database, everyone's files and the server's keys, kept
            somewhere other than this machine. Checked every week; restored into a scratch
            database every month to prove it works.
          </p>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-xs text-[var(--text)]">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => {
              setEnabled(e.target.checked);
              save.mutate(
                { ...settingsPatch(), enabled: e.target.checked },
                { onError: () => setEnabled(offsite.enabled) }
              );
            }}
            className="h-4 w-4 accent-[var(--accent)]"
            aria-label="Off-site backup on"
          />
          On
        </label>
      </div>

      <div
        role={offsite.healthy ? "status" : "alert"}
        className={cn(
          "flex items-start gap-2 rounded-card border px-3 py-2 text-xs",
          offsite.healthy
            ? "border-emerald-500/30 bg-emerald-500/5 text-[var(--text)]"
            : "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200"
        )}
      >
        {offsite.healthy ? (
          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
        ) : (
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        )}
        <span>
          {offsite.warning ??
            `Last off-site copy ${ok ? formatRelativeTime(ok.created_at) : "—"}${ok?.detail ? ` · ${ok.detail}` : ""}.`}
          {offsite.last_copy?.status === "failed" && offsite.last_copy.error && (
            <span className="mt-0.5 block">{offsite.last_copy.error}</span>
          )}
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs">
          <span className="mb-1 block font-medium text-[var(--text-muted)]">Where</span>
          <select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as OffsiteTargetKind);
              setCreds({});
              setTestResult(null);
            }}
            className={inputClass}
          >
            {TARGETS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-[11px] text-[var(--text-muted)]">
            {TARGETS.find((t) => t.value === kind)?.hint}
          </span>
        </label>
        <label className="block text-xs">
          <span className="mb-1 block font-medium text-[var(--text-muted)]">{LOCATION[kind].label}</span>
          <input
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder={LOCATION[kind].placeholder}
            className={inputClass}
          />
        </label>
        {CREDENTIALS[kind].map((c) => (
          <label key={c.key} className={cn("block text-xs", c.multiline && "sm:col-span-2")}>
            <span className="mb-1 block font-medium text-[var(--text-muted)]">
              {c.label}
              {offsite.target_kind === kind && offsite.credentials_set.includes(c.key) && (
                <span className="ml-1 font-normal">(saved — leave blank to keep)</span>
              )}
            </span>
            {c.multiline ? (
              <textarea
                rows={4}
                value={creds[c.key] ?? ""}
                onChange={(e) => setCreds((v) => ({ ...v, [c.key]: e.target.value }))}
                className={cn(inputClass, "font-mono")}
                spellCheck={false}
              />
            ) : (
              <input
                type={c.secret ? "password" : "text"}
                autoComplete="off"
                value={creds[c.key] ?? ""}
                onChange={(e) => setCreds((v) => ({ ...v, [c.key]: e.target.value }))}
                className={inputClass}
              />
            )}
          </label>
        ))}
        <label className="block text-xs">
          <span className="mb-1 block font-medium text-[var(--text-muted)]">Nightly at (UTC)</span>
          <select value={hour} onChange={(e) => setHour(Number(e.target.value))} className={inputClass}>
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>
                {String(h).padStart(2, "0")}:20
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 self-end pb-2 text-xs text-[var(--text)]">
          <input
            type="checkbox"
            checked={restoreTest}
            onChange={(e) => setRestoreTest(e.target.checked)}
            className="h-3.5 w-3.5 accent-[var(--accent)]"
          />
          Trial restore on the 1st of each month
        </label>
      </div>

      {testResult && <p className="text-xs text-[var(--text)]">{testResult}</p>}

      <div className="flex flex-wrap gap-2">
        <ActionButton busy={save.isPending || test.isPending} onClick={() => void saveAndTest()}>
          Save and test
        </ActionButton>
        <ActionButton busy={running} disabled={!offsite.enabled} onClick={() => action.mutate("run")}>
          Copy now
        </ActionButton>
        <ActionButton busy={false} disabled={!offsite.enabled || !ok} onClick={() => action.mutate("check")}>
          Check copies
        </ActionButton>
        <ActionButton busy={false} disabled={!offsite.enabled || !ok} onClick={() => action.mutate("restore-test")}>
          Trial restore
        </ActionButton>
      </div>

      <div className="grid gap-2 text-xs text-[var(--text-muted)] sm:grid-cols-3">
        <RunFact label="Last copy" run={offsite.last_copy} />
        <RunFact label="Last check" run={offsite.last_check} />
        <RunFact label="Last trial restore" run={offsite.last_restore_test} />
      </div>

      <p className="rounded-card border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-xs text-[var(--text-muted)]">
        The copies are encrypted with a password Promptly made for them. If this machine is
        lost, you need that password to read them: run{" "}
        <code className="font-mono">scripts/recovery-kit.sh</code> (or{" "}
        <code className="font-mono">.ps1</code> on Windows) on the server and keep the file it
        writes somewhere else — a password manager or a printout. It's never shown here.
      </p>
    </section>
  );
}

const inputClass =
  "w-full rounded-input border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-sm text-[var(--text)] focus:border-[var(--accent)] focus:outline-none";

function ActionButton({
  children,
  busy,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  busy: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || disabled}
      className="inline-flex items-center gap-1.5 rounded-input border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm text-[var(--text)] hover:bg-[var(--hover)] disabled:cursor-not-allowed disabled:opacity-60"
    >
      {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      {children}
    </button>
  );
}

function RunFact({ label, run }: { label: string; run: BackupRun | null }) {
  return (
    <div className="rounded-card border border-[var(--border)] bg-[var(--bg)] px-3 py-2">
      <div className="text-[11px] font-medium uppercase tracking-wide">{label}</div>
      <div
        className={cn(
          "mt-0.5",
          run?.status === "failed" ? "text-red-600 dark:text-red-400" : "text-[var(--text)]"
        )}
        title={run?.error ?? run?.detail ?? undefined}
      >
        {!run
          ? "Never"
          : run.status === "running"
            ? "Running…"
            : `${run.status === "ok" ? "OK" : run.status === "skipped" ? "Skipped" : "Failed"} · ${formatRelativeTime(run.created_at)}${
                run.status === "ok" && run.size_bytes ? ` · ${humanSize(run.size_bytes)}` : ""
              }`}
      </div>
    </div>
  );
}
