import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  KeyRound,
  ShieldCheck,
  Zap,
} from "lucide-react";

import { Button } from "@/components/shared/Button";
import { useAppSettings, useUpdateAppSettings } from "@/hooks/useAdminUsers";
import { useAvailableModels } from "@/hooks/useProviders";
import { cn } from "@/utils/cn";
import type { AppSettings, AvailableModel } from "@/api/types";
import type { AppSettingsPatch } from "@/api/admin";

import { SettingsCard } from "./SettingsCard";

/**
 * Admin → Settings → Email integration tab.
 *
 * Houses three cards:
 *   1. Kill switch + feature flag (email_integration_enabled)
 *   2. Google OAuth credentials (client ID + client secret)
 *   3. AI triage model + daily token cap
 *
 * Email is off by default. Admin must:
 *   a) Create a Google Cloud project + OAuth 2.0 credentials
 *   b) Paste client ID + secret here
 *   c) Flip the kill switch on
 * After that users can connect their accounts from Account → Email.
 */
export function EmailSettingsPanel() {
  const { data, isLoading, isError } = useAppSettings();
  const update = useUpdateAppSettings();

  if (isLoading) {
    return (
      <div className="text-sm text-[var(--text-muted)]">
        Loading email settings…
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="text-sm text-red-600 dark:text-red-400">
        Couldn't load settings. Refresh and try again.
      </div>
    );
  }

  const submit = (patch: AppSettingsPatch) => update.mutateAsync(patch);

  return (
    <div className="space-y-4">
      <header className="mb-2">
        <h2 className="text-sm font-semibold">Email integration</h2>
        <p className="text-xs text-[var(--text-muted)]">
          Connect users' Gmail accounts for AI-triaged inbox, email RAG, and
          the{" "}
          <code className="rounded bg-[var(--surface-raised)] px-1 py-0.5 font-mono text-[11px]">
            search_emails
          </code>{" "}
          chat tool. Off by default — configure credentials and flip the kill
          switch to enable.
        </p>
      </header>

      <KillSwitchCard settings={data} onSubmit={submit} busy={update.isPending} />
      <GoogleOAuthCard settings={data} onSubmit={submit} busy={update.isPending} />
      <TriageModelCard settings={data} onSubmit={submit} busy={update.isPending} />
    </div>
  );
}

interface CardProps {
  settings: AppSettings;
  onSubmit: (patch: AppSettingsPatch) => Promise<unknown>;
  busy: boolean;
}

// ------------------------------------------------------------------ //
// 1. Kill switch                                                       //
// ------------------------------------------------------------------ //

function KillSwitchCard({ settings, onSubmit, busy }: CardProps) {
  const [enabled, setEnabled] = useState(settings.email_integration_enabled);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    setEnabled(settings.email_integration_enabled);
  }, [settings.email_integration_enabled]);

  useEffect(() => {
    if (!savedAt) return;
    const t = window.setTimeout(() => setSavedAt(null), 3000);
    return () => window.clearTimeout(t);
  }, [savedAt]);

  const dirty = enabled !== settings.email_integration_enabled;

  const handleSave = async () => {
    setError(null);
    try {
      await onSubmit({ email_integration_enabled: enabled });
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <SettingsCard
      title="Feature status"
      icon={<ShieldCheck className="h-4 w-4" />}
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
                setEnabled(settings.email_integration_enabled);
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
      <p className="mb-3 text-xs text-[var(--text-muted)]">
        Org-wide kill switch. When off, all per-user email settings and sync
        are suspended. Flip on only after configuring Google OAuth credentials
        below — otherwise users will see a connection error.
      </p>

      {enabled && !settings.google_oauth_configured && (
        <div className="mb-3 flex items-start gap-2 rounded-card border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Google OAuth credentials are not configured. Users will see an
            error when trying to connect. Add credentials in the card below.
          </span>
        </div>
      )}

      <label className="flex cursor-pointer items-center gap-3">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            setEnabled(e.target.checked);
            setSavedAt(null);
          }}
          className="h-4 w-4 rounded border-[var(--border)] accent-[var(--accent)]"
        />
        <span className="text-sm">
          {enabled ? (
            <span className="font-medium text-emerald-700 dark:text-emerald-400">
              Enabled — users can connect Gmail accounts
            </span>
          ) : (
            <span className="text-[var(--text-muted)]">
              Disabled — email integration is off for everyone
            </span>
          )}
        </span>
      </label>
    </SettingsCard>
  );
}

// ------------------------------------------------------------------ //
// 2. Google OAuth credentials                                          //
// ------------------------------------------------------------------ //

function GoogleOAuthCard({ settings, onSubmit, busy }: CardProps) {
  const [clientId, setClientId] = useState(settings.google_oauth_client_id ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    setClientId(settings.google_oauth_client_id ?? "");
  }, [settings.google_oauth_client_id]);

  useEffect(() => {
    if (!savedAt) return;
    const t = window.setTimeout(() => setSavedAt(null), 3000);
    return () => window.clearTimeout(t);
  }, [savedAt]);

  const dirty =
    clientId.trim() !== (settings.google_oauth_client_id ?? "") ||
    clientSecret !== "";

  const handleSave = async () => {
    if (!clientId.trim()) {
      setError("Client ID is required.");
      return;
    }
    setError(null);
    try {
      const patch: AppSettingsPatch = {
        google_oauth_client_id: clientId.trim() || null,
      };
      if (clientSecret !== "") {
        patch.google_oauth_client_secret = clientSecret;
      }
      await onSubmit(patch);
      setClientSecret("");
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <SettingsCard
      title="Google OAuth credentials"
      icon={<KeyRound className="h-4 w-4" />}
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
                setClientId(settings.google_oauth_client_id ?? "");
                setClientSecret("");
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
        Promptly is self-hosted — you provision your own Google Cloud project.
        Create OAuth 2.0 credentials at{" "}
        <span className="font-medium">
          Google Cloud Console → APIs & Services → Credentials
        </span>
        . Set the redirect URI to{" "}
        <code className="rounded bg-[var(--surface-raised)] px-1 py-0.5 font-mono text-[11px]">
          https://&lt;your-domain&gt;/api/email/oauth/google/callback
        </code>
        . The secret is encrypted at rest.
      </p>

      <div className="space-y-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-[var(--text-muted)]">
            Client ID
          </span>
          <input
            type="text"
            value={clientId}
            onChange={(e) => {
              setClientId(e.target.value);
              setSavedAt(null);
            }}
            placeholder="1234567890-abc.apps.googleusercontent.com"
            disabled={busy}
            className={cn(
              "rounded-card border border-[var(--border)] bg-[var(--surface)] px-3 py-2 font-mono text-sm",
              "placeholder:text-[var(--text-placeholder)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40",
              "disabled:cursor-not-allowed disabled:opacity-60",
            )}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-[var(--text-muted)]">
            Client Secret{" "}
            {settings.google_oauth_configured && (
              <span className="ml-1 font-normal text-emerald-600 dark:text-emerald-400">
                (currently set)
              </span>
            )}
          </span>
          <input
            type="password"
            value={clientSecret}
            onChange={(e) => {
              setClientSecret(e.target.value);
              setSavedAt(null);
            }}
            placeholder={
              settings.google_oauth_configured
                ? "Leave blank to keep current secret"
                : "Paste secret to save"
            }
            disabled={busy}
            className={cn(
              "rounded-card border border-[var(--border)] bg-[var(--surface)] px-3 py-2 font-mono text-sm",
              "placeholder:text-[var(--text-placeholder)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40",
              "disabled:cursor-not-allowed disabled:opacity-60",
            )}
          />
        </label>
      </div>
    </SettingsCard>
  );
}

// ------------------------------------------------------------------ //
// 3. AI triage model + daily token cap                                 //
// ------------------------------------------------------------------ //

function TriageModelCard({ settings, onSubmit, busy }: CardProps) {
  const OFF = "";

  const initialKey =
    settings.email_triage_configured &&
    settings.email_triage_provider_id &&
    settings.email_triage_model_id
      ? `${settings.email_triage_provider_id}::${settings.email_triage_model_id}`
      : OFF;

  const [value, setValue] = useState(initialKey);
  const [cap, setCap] = useState<string>(
    settings.email_triage_daily_token_cap?.toString() ?? "",
  );
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const { data: models, isLoading: modelsLoading } = useAvailableModels();

  useEffect(() => {
    setValue(initialKey);
  }, [initialKey]);

  useEffect(() => {
    setCap(settings.email_triage_daily_token_cap?.toString() ?? "");
  }, [settings.email_triage_daily_token_cap]);

  useEffect(() => {
    if (!savedAt) return;
    const t = window.setTimeout(() => setSavedAt(null), 3000);
    return () => window.clearTimeout(t);
  }, [savedAt]);

  const eligible: AvailableModel[] = models ?? [];
  const grouped = useMemo(() => {
    const byProvider = new Map<string, AvailableModel[]>();
    for (const m of eligible) {
      const existing = byProvider.get(m.provider_name) ?? [];
      existing.push(m);
      byProvider.set(m.provider_name, existing);
    }
    return Array.from(byProvider.entries()).sort((a, b) =>
      a[0].localeCompare(b[0]),
    );
  }, [eligible]);

  const dirty =
    value !== initialKey ||
    cap !== (settings.email_triage_daily_token_cap?.toString() ?? "");

  const handleSave = async () => {
    setError(null);
    const capNum = cap === "" ? null : parseInt(cap, 10);
    if (cap !== "" && (isNaN(capNum!) || capNum! < 0)) {
      setError("Daily token cap must be a positive number or blank (no cap).");
      return;
    }
    try {
      const patch: AppSettingsPatch = {
        email_triage_daily_token_cap: capNum,
      };
      if (value === OFF) {
        patch.email_triage_provider_id = null;
        patch.email_triage_model_id = null;
      } else {
        const [provider_id, ...rest] = value.split("::");
        const model_id = rest.join("::");
        if (!provider_id || !model_id) {
          setError("Pick a model from the list, or choose Off.");
          return;
        }
        patch.email_triage_provider_id = provider_id;
        patch.email_triage_model_id = model_id;
      }
      await onSubmit(patch);
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <SettingsCard
      title="AI triage model"
      icon={<Zap className="h-4 w-4" />}
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
                setValue(initialKey);
                setCap(settings.email_triage_daily_token_cap?.toString() ?? "");
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
        Model used to categorise incoming emails, assign priority (0–10),
        generate a 1–2 sentence summary, detect deadlines, and flag
        needs-reply. Defaults to a local Ollama model so email bodies never
        leave the box. A heuristic pre-filter handles obvious bulk
        (newsletters, promotions) for free before touching the model.
      </p>

      <div className="space-y-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-[var(--text-muted)]">
            Triage model
          </span>
          <select
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setSavedAt(null);
            }}
            disabled={busy || modelsLoading}
            className={cn(
              "rounded-card border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm",
              "focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40",
              "disabled:cursor-not-allowed disabled:opacity-60",
            )}
          >
            <option value={OFF}>
              Off — heuristic pre-filter only (no AI triage)
            </option>
            {grouped.map(([providerName, entries]) => (
              <optgroup key={providerName} label={providerName}>
                {entries.map((m) => (
                  <option
                    key={`${m.provider_id}::${m.model_id}`}
                    value={`${m.provider_id}::${m.model_id}`}
                  >
                    {m.display_name || m.model_id}
                    {m.is_custom ? " (custom)" : ""}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          {modelsLoading && (
            <span className="text-xs text-[var(--text-muted)]">
              Loading models…
            </span>
          )}
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-[var(--text-muted)]">
            Daily token cap{" "}
            <span className="font-normal">
              (blank = no cap — set a limit for shared/metered installs)
            </span>
          </span>
          <input
            type="number"
            min={0}
            value={cap}
            onChange={(e) => {
              setCap(e.target.value);
              setSavedAt(null);
            }}
            placeholder="e.g. 500000"
            disabled={busy}
            className={cn(
              "w-48 rounded-card border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm",
              "placeholder:text-[var(--text-placeholder)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40",
              "disabled:cursor-not-allowed disabled:opacity-60",
            )}
          />
          <p className="text-xs text-[var(--text-muted)]">
            Tokens are shared across all users' triage passes. When the daily
            cap is hit, remaining untriaged emails are marked{" "}
            <code className="rounded bg-[var(--surface-raised)] px-1 py-0.5 font-mono text-[11px]">
              triage_disabled
            </code>{" "}
            and the cap resets at midnight UTC.
          </p>
        </label>
      </div>
    </SettingsCard>
  );
}
