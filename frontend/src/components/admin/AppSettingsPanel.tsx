import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Gauge, Loader2, Mail, ShieldAlert, ShieldCheck, TriangleAlert } from "lucide-react";

import { Button } from "@/components/shared/Button";
import { useAppSettings, useUpdateAppSettings } from "@/hooks/useAdminUsers";
import { cn } from "@/utils/cn";
import type { AppSettings } from "@/api/types";
import type { AppSettingsPatch } from "@/api/admin";

/**
 * Admin view + editor for the global ``app_settings`` row.
 *
 * Two cards:
 *   1. Authentication — currently the MFA master switch. Enabling it
 *      forces every user without MFA enrolled into the enrollment
 *      flow on next login (Phase 2 wiring).
 *   2. SMTP — credentials used by 2FA email codes and any future
 *      transactional mail. The password is write-only — the API
 *      returns a ``smtp_password_set`` boolean instead of the value.
 *
 * The form tracks dirty state per field so we only PATCH what changed,
 * which keeps audit-log entries readable.
 */
export function AppSettingsPanel() {
  const { data, isLoading, isError, error, refetch } = useAppSettings();
  const update = useUpdateAppSettings();

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading settings...
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div
        role="alert"
        className="rounded-card border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400"
      >
        Failed to load settings:{" "}
        {error instanceof Error ? error.message : "Unknown error"}
        <Button size="sm" variant="ghost" className="ml-3" onClick={() => refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <AuthCard
        settings={data}
        onSubmit={(patch) => update.mutateAsync(patch)}
        busy={update.isPending}
      />
      <SmtpCard
        settings={data}
        onSubmit={(patch) => update.mutateAsync(patch)}
        busy={update.isPending}
      />
      <QuotasCard
        settings={data}
        onSubmit={(patch) => update.mutateAsync(patch)}
        busy={update.isPending}
      />
    </div>
  );
}

// --------------------------------------------------------------------
// Quotas card — org-wide defaults applied to users without an override
// --------------------------------------------------------------------
const BYTES_PER_GB = 1024 * 1024 * 1024;

/**
 * Render a byte count as a GB string. Whole numbers render without
 * a decimal (e.g. "10"); sub-GB values show up to two decimals so
 * stored 500 MB reads as "0.49" rather than "0.48828125".
 */
function bytesToGbString(bytes: number): string {
  const gb = bytes / BYTES_PER_GB;
  if (gb === 0) return "0";
  const rounded = Math.round(gb * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/\.?0+$/, "");
}

interface QuotasForm {
  default_storage_cap_gb: string;
  default_daily_token_budget: string;
  default_monthly_token_budget: string;
}

function quotasToForm(s: AppSettings): QuotasForm {
  return {
    default_storage_cap_gb:
      s.default_storage_cap_bytes == null
        ? ""
        : bytesToGbString(s.default_storage_cap_bytes),
    default_daily_token_budget:
      s.default_daily_token_budget == null
        ? ""
        : String(s.default_daily_token_budget),
    default_monthly_token_budget:
      s.default_monthly_token_budget == null
        ? ""
        : String(s.default_monthly_token_budget),
  };
}

function QuotasCard({ settings, onSubmit, busy }: CardSubmit) {
  const initial = useMemo(() => quotasToForm(settings), [settings]);
  const [form, setForm] = useState<QuotasForm>(initial);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    setForm(initial);
  }, [initial]);

  const dirty =
    form.default_storage_cap_gb !== initial.default_storage_cap_gb ||
    form.default_daily_token_budget !== initial.default_daily_token_budget ||
    form.default_monthly_token_budget !== initial.default_monthly_token_budget;

  const setField = <K extends keyof QuotasForm>(key: K, value: QuotasForm[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setError(null);
    setSavedAt(null);
  };

  // Convert "" → null (revert to "uncapped"), otherwise parse a
  // non-negative integer. Reject typos rather than silently sending 0.
  const parseQuota = (raw: string): number | null | "invalid" => {
    if (raw.trim() === "") return null;
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n) || n < 0) return "invalid";
    return n;
  };

  // Storage is entered in GB with decimals allowed (e.g. "0.5"), so
  // it needs a separate parser from the integer-only token quotas.
  const parseGbToBytes = (raw: string): number | null | "invalid" => {
    if (raw.trim() === "") return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return "invalid";
    return Math.round(n * BYTES_PER_GB);
  };

  const handleSave = async () => {
    setError(null);
    const patch: AppSettingsPatch = {};

    if (form.default_storage_cap_gb !== initial.default_storage_cap_gb) {
      const bytes = parseGbToBytes(form.default_storage_cap_gb);
      if (bytes === "invalid") {
        setError("Storage default must be a non-negative number of GB.");
        return;
      }
      patch.default_storage_cap_bytes = bytes;
    }
    if (
      form.default_daily_token_budget !== initial.default_daily_token_budget
    ) {
      const v = parseQuota(form.default_daily_token_budget);
      if (v === "invalid") {
        setError("Daily token default must be a non-negative integer.");
        return;
      }
      patch.default_daily_token_budget = v;
    }
    if (
      form.default_monthly_token_budget !== initial.default_monthly_token_budget
    ) {
      const v = parseQuota(form.default_monthly_token_budget);
      if (v === "invalid") {
        setError("Monthly token default must be a non-negative integer.");
        return;
      }
      patch.default_monthly_token_budget = v;
    }

    try {
      await onSubmit(patch);
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    if (!savedAt) return;
    const t = window.setTimeout(() => setSavedAt(null), 3000);
    return () => window.clearTimeout(t);
  }, [savedAt]);

  return (
    <Card
      title="Default quotas"
      icon={<Gauge className="h-4 w-4" />}
      footer={
        <>
          {error && (
            <span className="mr-auto text-xs text-red-600 dark:text-red-400">
              {error}
            </span>
          )}
          {savedAt && !error && (
            <span className="mr-auto inline-flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Saved
            </span>
          )}
          {dirty && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setForm(initial);
                setError(null);
              }}
              disabled={busy}
            >
              Discard
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            onClick={handleSave}
            disabled={!dirty || busy}
            loading={busy}
          >
            Save
          </Button>
        </>
      }
    >
      <p className="mb-4 text-xs text-[var(--text-muted)]">
        Applied to every user whose own override is unset. Leave a field
        blank to keep that quota uncapped. Token budgets count prompt +
        completion tokens combined; storage applies to each user's
        private file pool only (admin-uploaded shared files are
        untracked).
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field
          label="Storage / user (GB)"
          value={form.default_storage_cap_gb}
          onChange={(v) => setField("default_storage_cap_gb", v)}
          placeholder="unlimited"
          type="number"
          step={0.1}
          min={0}
          disabled={busy}
        />
        <Field
          label="Daily tokens / user"
          value={form.default_daily_token_budget}
          onChange={(v) => setField("default_daily_token_budget", v)}
          placeholder="unlimited"
          type="number"
          disabled={busy}
        />
        <Field
          label="Monthly tokens / user"
          value={form.default_monthly_token_budget}
          onChange={(v) => setField("default_monthly_token_budget", v)}
          placeholder="unlimited"
          type="number"
          disabled={busy}
        />
      </div>
    </Card>
  );
}

// --------------------------------------------------------------------
// Authentication card — MFA master switch
// --------------------------------------------------------------------
interface CardSubmit {
  settings: AppSettings;
  onSubmit: (patch: AppSettingsPatch) => Promise<unknown>;
  busy: boolean;
}

function AuthCard({ settings, onSubmit, busy }: CardSubmit) {
  const [mfaRequired, setMfaRequired] = useState(settings.mfa_required);
  const [error, setError] = useState<string | null>(null);
  const [confirmFlip, setConfirmFlip] = useState(false);

  // Sync local state when the server value changes (e.g. another tab).
  useEffect(() => {
    setMfaRequired(settings.mfa_required);
  }, [settings.mfa_required]);

  const dirty = mfaRequired !== settings.mfa_required;
  const enabling = mfaRequired && !settings.mfa_required;

  const handleSave = async () => {
    setError(null);
    // Enabling MFA is a high-impact change (everyone gets force-enrolled
    // on next login). Make the admin acknowledge it explicitly before
    // we PATCH.
    if (enabling && !confirmFlip) {
      setConfirmFlip(true);
      return;
    }
    try {
      await onSubmit({ mfa_required: mfaRequired });
      setConfirmFlip(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Card
      title="Authentication"
      icon={<ShieldCheck className="h-4 w-4" />}
      footer={
        <>
          {error && (
            <span className="mr-auto text-xs text-red-600 dark:text-red-400">
              {error}
            </span>
          )}
          {dirty && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setMfaRequired(settings.mfa_required);
                setConfirmFlip(false);
                setError(null);
              }}
              disabled={busy}
            >
              Discard
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            onClick={handleSave}
            disabled={!dirty || busy}
            loading={busy}
          >
            {enabling && confirmFlip ? "Yes, require MFA" : "Save"}
          </Button>
        </>
      }
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <label
            htmlFor="mfa-required-toggle"
            className="text-sm font-medium text-[var(--text)]"
          >
            Require multi-factor authentication
          </label>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            When enabled, every user without MFA enrolled is forced through
            the enrollment flow on their next login. Existing sessions are
            not invalidated. Users can choose between an authenticator app
            (TOTP) or one-time emailed codes.
          </p>
        </div>
        <Toggle
          id="mfa-required-toggle"
          checked={mfaRequired}
          onChange={(v) => {
            setMfaRequired(v);
            // Reset the confirm-step if they toggle off again.
            if (!v) setConfirmFlip(false);
          }}
          disabled={busy}
        />
      </div>

      {enabling && confirmFlip && (
        <div
          role="alert"
          className={cn(
            "mt-4 flex items-start gap-2.5 rounded-card border px-3 py-2.5 text-xs",
            "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
          )}
        >
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Every user without MFA configured will be required to enroll on
            their next login before they can use the app. Click <span className="font-semibold">Yes, require MFA</span> again to confirm.
          </span>
        </div>
      )}
    </Card>
  );
}

// --------------------------------------------------------------------
// SMTP card
// --------------------------------------------------------------------
interface SmtpForm {
  smtp_host: string;
  smtp_port: string;
  smtp_username: string;
  smtp_password: string;
  smtp_use_tls: boolean;
  smtp_from_address: string;
  smtp_from_name: string;
}

function settingsToForm(s: AppSettings): SmtpForm {
  return {
    smtp_host: s.smtp_host ?? "",
    smtp_port: s.smtp_port == null ? "" : String(s.smtp_port),
    smtp_username: s.smtp_username ?? "",
    // Password is never returned by the API. The placeholder uses
    // smtp_password_set to tell the user there's already one stored.
    smtp_password: "",
    smtp_use_tls: s.smtp_use_tls,
    smtp_from_address: s.smtp_from_address ?? "",
    smtp_from_name: s.smtp_from_name ?? "",
  };
}

function SmtpCard({ settings, onSubmit, busy }: CardSubmit) {
  const initial = useMemo(() => settingsToForm(settings), [settings]);
  const [form, setForm] = useState<SmtpForm>(initial);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [clearPassword, setClearPassword] = useState(false);

  // Resync if the source-of-truth changes (after a successful save or
  // a refetch). Don't blow away an in-progress edit by a stale fetch.
  useEffect(() => {
    setForm(initial);
    setClearPassword(false);
  }, [initial]);

  const dirty = useMemo(() => {
    if (clearPassword) return true;
    if (form.smtp_password.length > 0) return true;
    return (
      form.smtp_host !== initial.smtp_host ||
      form.smtp_port !== initial.smtp_port ||
      form.smtp_username !== initial.smtp_username ||
      form.smtp_use_tls !== initial.smtp_use_tls ||
      form.smtp_from_address !== initial.smtp_from_address ||
      form.smtp_from_name !== initial.smtp_from_name
    );
  }, [form, initial, clearPassword]);

  const setField = <K extends keyof SmtpForm>(key: K, value: SmtpForm[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setError(null);
    setSavedAt(null);
  };

  const handleSave = async () => {
    setError(null);

    // Build a minimal patch: only fields that actually changed. Avoids
    // noisy audit rows and accidental clobbering.
    const patch: AppSettingsPatch = {};
    if (form.smtp_host !== initial.smtp_host)
      patch.smtp_host = form.smtp_host || null;
    if (form.smtp_port !== initial.smtp_port) {
      patch.smtp_port = form.smtp_port === "" ? null : Number(form.smtp_port);
      if (patch.smtp_port !== null && Number.isNaN(patch.smtp_port)) {
        setError("Port must be a number between 1 and 65535.");
        return;
      }
    }
    if (form.smtp_username !== initial.smtp_username)
      patch.smtp_username = form.smtp_username || null;
    if (clearPassword) patch.smtp_password = "";
    else if (form.smtp_password.length > 0)
      patch.smtp_password = form.smtp_password;
    if (form.smtp_use_tls !== initial.smtp_use_tls)
      patch.smtp_use_tls = form.smtp_use_tls;
    if (form.smtp_from_address !== initial.smtp_from_address)
      patch.smtp_from_address = form.smtp_from_address || null;
    if (form.smtp_from_name !== initial.smtp_from_name)
      patch.smtp_from_name = form.smtp_from_name || null;

    try {
      await onSubmit(patch);
      setSavedAt(Date.now());
      setForm((prev) => ({ ...prev, smtp_password: "" }));
      setClearPassword(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // Auto-dismiss the success indicator after a moment so it doesn't
  // sit there forever.
  useEffect(() => {
    if (!savedAt) return;
    const t = window.setTimeout(() => setSavedAt(null), 3000);
    return () => window.clearTimeout(t);
  }, [savedAt]);

  const passwordPlaceholder = settings.smtp_password_set
    ? "•••••••• (leave blank to keep current)"
    : "Not set";

  return (
    <Card
      title="SMTP server"
      icon={<Mail className="h-4 w-4" />}
      headerExtra={
        <ConfigBadge
          configured={settings.smtp_configured}
          passwordSet={settings.smtp_password_set}
        />
      }
      footer={
        <>
          {error && (
            <span className="mr-auto text-xs text-red-600 dark:text-red-400">
              {error}
            </span>
          )}
          {savedAt && !error && (
            <span className="mr-auto inline-flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Saved
            </span>
          )}
          {dirty && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setForm(initial);
                setClearPassword(false);
                setError(null);
              }}
              disabled={busy}
            >
              Discard
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            onClick={handleSave}
            disabled={!dirty || busy}
            loading={busy}
          >
            Save
          </Button>
        </>
      }
    >
      <p className="mb-4 text-xs text-[var(--text-muted)]">
        Used by 2FA email codes and any future transactional mail
        (password resets, account notices). The password is encrypted at
        rest with the same key used for provider API keys, and is never
        returned by the API after it's been saved.
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field
          label="Host"
          value={form.smtp_host}
          onChange={(v) => setField("smtp_host", v)}
          placeholder="smtp.example.com"
          disabled={busy}
        />
        <Field
          label="Port"
          value={form.smtp_port}
          onChange={(v) => setField("smtp_port", v)}
          placeholder="587"
          type="number"
          disabled={busy}
        />
        <Field
          label="Username"
          value={form.smtp_username}
          onChange={(v) => setField("smtp_username", v)}
          placeholder="noreply@example.com"
          autoComplete="off"
          disabled={busy}
        />
        <PasswordField
          value={form.smtp_password}
          onChange={(v) => {
            setField("smtp_password", v);
            if (v.length > 0) setClearPassword(false);
          }}
          placeholder={passwordPlaceholder}
          disabled={busy || clearPassword}
          afterInput={
            settings.smtp_password_set && (
              <button
                type="button"
                onClick={() => {
                  setClearPassword((v) => !v);
                  if (!clearPassword) setField("smtp_password", "");
                }}
                className={cn(
                  "text-[11px] font-medium underline-offset-2",
                  clearPassword
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-[var(--text-muted)] hover:underline"
                )}
                disabled={busy}
              >
                {clearPassword ? "Will clear on save" : "Clear stored password"}
              </button>
            )
          }
        />
        <Field
          label="From address"
          value={form.smtp_from_address}
          onChange={(v) => setField("smtp_from_address", v)}
          placeholder="noreply@example.com"
          type="email"
          disabled={busy}
        />
        <Field
          label="From name"
          value={form.smtp_from_name}
          onChange={(v) => setField("smtp_from_name", v)}
          placeholder="Promptly"
          disabled={busy}
        />
      </div>

      <div className="mt-4 flex items-center justify-between gap-4 rounded-input border border-[var(--border)] bg-black/[0.02] px-3 py-2 dark:bg-white/[0.03]">
        <div className="min-w-0">
          <div className="text-sm font-medium text-[var(--text)]">
            Use STARTTLS / TLS
          </div>
          <p className="text-xs text-[var(--text-muted)]">
            Recommended on. Most providers require it on port 587 or 465.
          </p>
        </div>
        <Toggle
          checked={form.smtp_use_tls}
          onChange={(v) => setField("smtp_use_tls", v)}
          disabled={busy}
        />
      </div>
    </Card>
  );
}

// --------------------------------------------------------------------
// Tiny presentational helpers — kept local so AppSettingsPanel is
// self-contained. If we end up reusing them elsewhere we can promote.
// --------------------------------------------------------------------
function Card({
  title,
  icon,
  headerExtra,
  footer,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  headerExtra?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-card border border-[var(--border)] bg-[var(--surface)]">
      <header className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
        <div className="flex items-center gap-2">
          {icon && <span className="text-[var(--text-muted)]">{icon}</span>}
          <h3 className="text-sm font-semibold">{title}</h3>
        </div>
        {headerExtra}
      </header>
      <div className="px-4 py-4">{children}</div>
      {footer && (
        <footer className="flex items-center justify-end gap-2 border-t border-[var(--border)] px-4 py-3">
          {footer}
        </footer>
      )}
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  disabled,
  autoComplete,
  step,
  min,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  disabled?: boolean;
  autoComplete?: string;
  step?: number | string;
  min?: number | string;
}) {
  return (
    <label className="block text-xs">
      <span className="mb-1 block font-medium text-[var(--text-muted)]">
        {label}
      </span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete={autoComplete}
        step={step}
        min={min}
        className={cn(
          "w-full rounded-input border bg-[var(--bg)] px-3 py-1.5 text-sm",
          "border-[var(--border)] text-[var(--text)] placeholder:text-[var(--text-muted)]",
          "focus:border-[var(--accent)] focus:outline-none",
          "disabled:cursor-not-allowed disabled:opacity-60"
        )}
      />
    </label>
  );
}

function PasswordField({
  value,
  onChange,
  placeholder,
  disabled,
  afterInput,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  afterInput?: React.ReactNode;
}) {
  return (
    <label className="block text-xs">
      <span className="mb-1 flex items-center justify-between">
        <span className="font-medium text-[var(--text-muted)]">Password</span>
        {afterInput}
      </span>
      <input
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="new-password"
        className={cn(
          "w-full rounded-input border bg-[var(--bg)] px-3 py-1.5 text-sm",
          "border-[var(--border)] text-[var(--text)] placeholder:text-[var(--text-muted)]",
          "focus:border-[var(--accent)] focus:outline-none",
          "disabled:cursor-not-allowed disabled:opacity-60"
        )}
      />
    </label>
  );
}

function Toggle({
  id,
  checked,
  onChange,
  disabled,
}: {
  id?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      disabled={disabled}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition",
        checked ? "bg-[var(--accent)]" : "bg-black/15 dark:bg-white/15",
        "disabled:cursor-not-allowed disabled:opacity-60",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)]"
      )}
    >
      <span
        aria-hidden
        className={cn(
          "inline-block h-5 w-5 transform rounded-full bg-white shadow transition",
          checked ? "translate-x-5" : "translate-x-0.5"
        )}
      />
    </button>
  );
}

function ConfigBadge({
  configured,
  passwordSet,
}: {
  configured: boolean;
  passwordSet: boolean;
}) {
  if (configured && passwordSet) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-400">
        <CheckCircle2 className="h-3 w-3" />
        Configured
      </span>
    );
  }
  if (configured && !passwordSet) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:text-amber-400">
        <ShieldAlert className="h-3 w-3" />
        Missing password
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-black/[0.05] px-2 py-0.5 text-[11px] font-semibold text-[var(--text-muted)] dark:bg-white/[0.06]">
      Not configured
    </span>
  );
}
