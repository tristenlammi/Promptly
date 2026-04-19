import { useEffect, useState } from "react";
import axios from "axios";
import {
  CheckCircle2,
  KeyRound,
  Mail,
  Monitor,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
} from "lucide-react";

import { mfaApi } from "@/api/mfa";
import type {
  MfaBackupCodesPayload,
  MfaStatus,
  MfaTrustedDevice,
} from "@/api/types";
import { Button } from "@/components/shared/Button";
import { Modal } from "@/components/shared/Modal";

import { BackupCodesPanel } from "./BackupCodesPanel";
import { EnrollmentWizard } from "./EnrollmentWizard";

/** Self-service MFA settings panel.
 *
 * Composed of three cards stacked vertically:
 *
 *   1. Status + enroll/disable button
 *   2. Backup codes (remaining count + regenerate)
 *   3. Trusted devices (list + revoke)
 *
 * Each card refreshes the status query on mutation so counters stay
 * accurate without a full page reload.
 */
export function MfaSettingsPanel({ defaultEmail }: { defaultEmail?: string }) {
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [devices, setDevices] = useState<MfaTrustedDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setError(null);
    try {
      const [s, d] = await Promise.all([
        mfaApi.status(),
        mfaApi.listTrustedDevices(),
      ]);
      setStatus(s);
      setDevices(d);
    } catch (err) {
      setError(explainError(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Modal flags drive the enroll/disable/regenerate dialogs. Keeping
  // them in plain useState (not useReducer) because the panel is
  // small and each dialog is independent.
  const [enrolling, setEnrolling] = useState(false);
  const [disablingOpen, setDisablingOpen] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [newCodes, setNewCodes] = useState<string[] | null>(null);

  if (loading) {
    return (
      <div className="text-sm text-[var(--text-muted)]">Loading…</div>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <div
          role="alert"
          className="rounded-card border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400"
        >
          {error}
        </div>
      )}

      {/* ---- Status card ---- */}
      <Card>
        <div className="flex items-start gap-3">
          <div
            className={`flex h-10 w-10 items-center justify-center rounded-lg ${
              status?.enrolled
                ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                : "bg-amber-500/15 text-amber-600 dark:text-amber-400"
            }`}
          >
            {status?.enrolled ? (
              <ShieldCheck className="h-5 w-5" />
            ) : (
              <ShieldAlert className="h-5 w-5" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold">
                Two-step verification
              </h3>
              <StatusPill enrolled={!!status?.enrolled} />
            </div>
            {status?.enrolled ? (
              <p className="mt-1 text-xs text-[var(--text-muted)]">
                Enrolled with{" "}
                <strong className="font-medium text-[var(--text)]">
                  {status.method === "totp" ? "an authenticator app" : "email"}
                </strong>{" "}
                on {fmtDate(status.enrolled_at)}.
                {status.last_used_at && (
                  <>
                    {" "}
                    Last used {fmtDate(status.last_used_at)}.
                  </>
                )}
              </p>
            ) : (
              <p className="mt-1 text-xs text-[var(--text-muted)]">
                Add a second factor so a stolen password isn't enough to sign
                into your account.
              </p>
            )}
          </div>
          <div className="shrink-0">
            {status?.enrolled ? (
              <Button
                variant="secondary"
                onClick={() => setDisablingOpen(true)}
              >
                Disable
              </Button>
            ) : (
              <Button variant="primary" onClick={() => setEnrolling(true)}>
                Enable
              </Button>
            )}
          </div>
        </div>
      </Card>

      {/* ---- Backup codes ---- */}
      {status?.enrolled && (
        <Card>
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--accent)]/15 text-[var(--accent)]">
              <KeyRound className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-semibold">Backup codes</h3>
              <p className="mt-1 text-xs text-[var(--text-muted)]">
                {status.backup_codes_remaining} unused code
                {status.backup_codes_remaining === 1 ? "" : "s"} remaining.
                Generating a new set invalidates the old set.
              </p>
            </div>
            <div className="shrink-0">
              <Button
                variant="secondary"
                onClick={() => setRegenerating(true)}
              >
                Regenerate
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* ---- Trusted devices ---- */}
      {status?.enrolled && (
        <Card>
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--accent)]/15 text-[var(--accent)]">
              <Monitor className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-semibold">Trusted devices</h3>
              <p className="mt-1 text-xs text-[var(--text-muted)]">
                Devices you've trusted skip two-step verification for 30 days.
              </p>

              {devices.length === 0 ? (
                <div className="mt-3 rounded-card border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-xs text-[var(--text-muted)]">
                  No trusted devices.
                </div>
              ) : (
                <ul className="mt-3 space-y-2">
                  {devices.map((d) => (
                    <li
                      key={d.id}
                      className="flex items-start gap-3 rounded-card border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs font-medium">
                          {prettyUserAgent(d.label)}
                        </div>
                        <div className="mt-0.5 text-[11px] text-[var(--text-muted)]">
                          {d.ip || "unknown IP"} · added{" "}
                          {fmtDate(d.created_at)}
                          {d.last_used_at && (
                            <> · last used {fmtDate(d.last_used_at)}</>
                          )}
                          <> · expires {fmtDate(d.expires_at)}</>
                        </div>
                      </div>
                      <button
                        onClick={async () => {
                          try {
                            await mfaApi.revokeTrustedDevice(d.id);
                            await refresh();
                          } catch (err) {
                            setError(explainError(err));
                          }
                        }}
                        className="shrink-0 text-xs text-red-500 hover:underline"
                      >
                        Revoke
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {devices.length > 1 && (
                <button
                  onClick={async () => {
                    try {
                      await mfaApi.revokeAllTrustedDevices();
                      await refresh();
                    } catch (err) {
                      setError(explainError(err));
                    }
                  }}
                  className="mt-3 text-xs text-red-500 hover:underline"
                >
                  Revoke all devices
                </button>
              )}
            </div>
          </div>
        </Card>
      )}

      {/* ---- Enroll modal ---- */}
      {enrolling && (
        <Modal
          open={enrolling}
          onClose={() => setEnrolling(false)}
          title="Enable two-step verification"
        >
          <div className="px-2 pb-2">
            <EnrollmentWizard
              api={{
                beginTotp: mfaApi.beginTotp,
                verifyTotp: mfaApi.verifyTotp,
                beginEmail: mfaApi.beginEmail,
                verifyEmail: mfaApi.verifyEmail,
              }}
              defaultEmail={defaultEmail}
              heading="Choose your second factor"
              subheading="Pick a method to verify it's you on every sign-in."
              onComplete={async () => {
                setEnrolling(false);
                await refresh();
              }}
              onCancel={() => setEnrolling(false)}
            />
          </div>
        </Modal>
      )}

      {/* ---- Disable modal ---- */}
      {disablingOpen && (
        <DisableMfaModal
          method={status?.method ?? null}
          onClose={() => setDisablingOpen(false)}
          onDone={async () => {
            setDisablingOpen(false);
            await refresh();
          }}
        />
      )}

      {/* ---- Regenerate modal ---- */}
      {regenerating && (
        <RegenerateBackupCodesModal
          onClose={() => {
            setRegenerating(false);
            setNewCodes(null);
            void refresh();
          }}
          onCodes={(payload) => setNewCodes(payload.codes)}
          codes={newCodes}
        />
      )}
    </div>
  );
}

// =====================================================================
// Modals
// =====================================================================
function DisableMfaModal({
  method,
  onClose,
  onDone,
}: {
  method: "totp" | "email" | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal open onClose={onClose} title="Disable two-step verification">
      <div className="space-y-3 px-2 pb-2 text-sm">
        <p className="text-xs text-[var(--text-muted)]">
          Confirm your password and a current{" "}
          {method === "email" ? "email" : "authenticator"} code (or a backup
          code) to disable two-step verification. All trusted devices will be
          revoked.
        </p>
        <Input
          label="Current password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
        />
        <Input
          label={
            method === "email"
              ? "Email code or backup code"
              : "Authenticator code or backup code"
          }
          value={code}
          onChange={setCode}
          autoComplete="one-time-code"
        />
        {error && (
          <div
            role="alert"
            className="rounded-card border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400"
          >
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={busy}
            disabled={!password.trim() || !code.trim()}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await mfaApi.disable(password, code.trim());
                onDone();
              } catch (err) {
                setError(explainError(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            Disable
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function RegenerateBackupCodesModal({
  onClose,
  onCodes,
  codes,
}: {
  onClose: () => void;
  onCodes: (payload: MfaBackupCodesPayload) => void;
  codes: string[] | null;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal open onClose={onClose} title="Regenerate backup codes">
      <div className="space-y-3 px-2 pb-2 text-sm">
        {codes ? (
          <>
            <p className="text-xs text-[var(--text-muted)]">
              Your previous backup codes are now invalid. Save these somewhere
              safe — they will not be shown again.
            </p>
            <BackupCodesPanel codes={codes} />
            <div className="flex justify-end pt-2">
              <Button variant="primary" onClick={onClose}>
                Done
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-xs text-[var(--text-muted)]">
              This will invalidate your existing backup codes and generate a
              fresh set. Continue?
            </p>
            {error && (
              <div
                role="alert"
                className="rounded-card border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400"
              >
                {error}
              </div>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button
                variant="primary"
                loading={busy}
                onClick={async () => {
                  setBusy(true);
                  setError(null);
                  try {
                    const payload = await mfaApi.regenerateBackupCodes();
                    onCodes(payload);
                  } catch (err) {
                    setError(explainError(err));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Generate new codes
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

// =====================================================================
// Tiny presentational helpers
// =====================================================================
function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-4">
      {children}
    </div>
  );
}

function StatusPill({ enrolled }: { enrolled: boolean }) {
  return enrolled ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
      <CheckCircle2 className="h-3 w-3" />
      On
    </span>
  ) : (
    <span className="inline-flex rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-400">
      Off
    </span>
  );
}

function Input({
  label,
  value,
  onChange,
  ...rest
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
        {label}
      </span>
      <input
        {...rest}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-input border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]/60"
      />
    </label>
  );
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function prettyUserAgent(ua: string): string {
  if (!ua) return "Unknown device";
  // Keep it cheap — surface the first plausible browser+os hints
  // rather than dragging in a full UA-parser.
  const firefox = /Firefox\/(\S+)/.exec(ua)?.[0];
  const chrome = /Chrome\/(\S+)/.exec(ua)?.[0];
  const safari = /Version\/(\S+).*Safari/.exec(ua) ? "Safari" : null;
  const edge = /Edg\/(\S+)/.exec(ua)?.[0];
  const browser = edge || firefox || chrome || safari || "Browser";

  const platform =
    /Windows NT/.test(ua)
      ? "Windows"
      : /Mac OS X/.test(ua)
        ? "macOS"
        : /Android/.test(ua)
          ? "Android"
          : /iPhone|iPad|iPod/.test(ua)
            ? "iOS"
            : /Linux/.test(ua)
              ? "Linux"
              : "Unknown";

  return `${browser} on ${platform}`;
}

function explainError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    return (
      (err.response?.data as { detail?: string })?.detail ||
      err.message ||
      "Something went wrong."
    );
  }
  return err instanceof Error ? err.message : "Something went wrong.";
}

// Make linter happy about unused icon imports kept for future copy.
const _icons = { Smartphone, Mail };
void _icons;
