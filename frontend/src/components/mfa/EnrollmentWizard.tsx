import { useState } from "react";
import axios from "axios";
import { Mail, ShieldCheck, Smartphone } from "lucide-react";

import type {
  MfaEmailEnrollPayload,
  MfaEnrollmentCompletePayload,
  MfaMethod,
  MfaTotpEnrollPayload,
} from "@/api/types";
import { Button } from "@/components/shared/Button";

import { BackupCodesPanel } from "./BackupCodesPanel";

/** Steps the wizard walks through, in order. */
type Step =
  | "choose"
  | "totp_show"
  | "totp_verify"
  | "email_send"
  | "email_verify"
  | "backup";

/** Caller injects the right API methods so the same wizard works for
 * the forced-enrollment flow (which uses ``...forced`` endpoints
 * and an enrollment token) *and* the self-service flow from settings
 * (which uses the regular session). Keeping the network plumbing as
 * props keeps the UI logic free of any auth-flow knowledge. */
export interface EnrollmentApi {
  beginTotp: () => Promise<MfaTotpEnrollPayload>;
  verifyTotp: (code: string) => Promise<MfaEnrollmentCompletePayload>;
  beginEmail: (emailAddress?: string) => Promise<MfaEmailEnrollPayload>;
  verifyEmail: (code: string) => Promise<MfaEnrollmentCompletePayload>;
}

export interface EnrollmentWizardProps {
  api: EnrollmentApi;
  /** Pre-fill for the email-method input. */
  defaultEmail?: string;
  /** "Title" shown above the picker — copy varies by entry context. */
  heading: string;
  subheading: string;
  /** Called once the user clicks "I've saved my codes" on the final
   * screen. The full enrollment payload is provided so callers can
   * (e.g.) flip auth state with the freshly-issued access token. */
  onComplete: (payload: MfaEnrollmentCompletePayload) => void;
  /** Optional cancel target — hides the cancel link if omitted. */
  onCancel?: () => void;
}

export function EnrollmentWizard({
  api,
  defaultEmail,
  heading,
  subheading,
  onComplete,
  onCancel,
}: EnrollmentWizardProps) {
  const [step, setStep] = useState<Step>("choose");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [method, setMethod] = useState<MfaMethod | null>(null);

  const [totpPayload, setTotpPayload] = useState<MfaTotpEnrollPayload | null>(
    null
  );
  const [emailHint, setEmailHint] = useState<string | null>(null);
  const [emailAddress, setEmailAddress] = useState<string>(defaultEmail ?? "");

  const [code, setCode] = useState("");
  const [final, setFinal] = useState<MfaEnrollmentCompletePayload | null>(null);

  const reset = () => {
    setStep("choose");
    setMethod(null);
    setTotpPayload(null);
    setEmailHint(null);
    setCode("");
    setError(null);
    setFinal(null);
  };

  const explainError = (err: unknown): string => {
    if (axios.isAxiosError(err)) {
      const detail = (err.response?.data as { detail?: string })?.detail;
      return detail || err.message || "Something went wrong.";
    }
    return err instanceof Error ? err.message : "Something went wrong.";
  };

  // -------------------- Step: choose --------------------
  if (step === "choose") {
    return (
      <Wrap heading={heading} subheading={subheading} onCancel={onCancel}>
        <div className="grid gap-3">
          <MethodCard
            icon={<Smartphone className="h-5 w-5" />}
            title="Authenticator app"
            description="Use Google Authenticator, 1Password, Authy, or any TOTP app. Recommended."
            onClick={async () => {
              setError(null);
              setBusy(true);
              try {
                const payload = await api.beginTotp();
                setTotpPayload(payload);
                setMethod("totp");
                setStep("totp_show");
              } catch (err) {
                setError(explainError(err));
              } finally {
                setBusy(false);
              }
            }}
            disabled={busy}
          />
          <MethodCard
            icon={<Mail className="h-5 w-5" />}
            title="Email"
            description="A six-digit code is sent to your inbox each time you sign in. Requires the admin to have configured SMTP."
            onClick={() => {
              setMethod("email");
              setStep("email_send");
            }}
            disabled={busy}
          />
        </div>
        {error && <ErrorBanner>{error}</ErrorBanner>}
      </Wrap>
    );
  }

  // -------------------- Step: TOTP — show secret/QR --------------------
  if (step === "totp_show" && totpPayload) {
    return (
      <Wrap
        heading="Scan the QR code"
        subheading="Open your authenticator app and add a new account, then continue."
        onCancel={onCancel}
        onBack={reset}
      >
        <div className="flex flex-col items-center gap-3">
          <img
            src={totpPayload.qr_data_uri}
            alt="TOTP QR code"
            className="h-44 w-44 rounded-card border border-[var(--border)] bg-white p-2"
          />
          <p className="text-center text-xs text-[var(--text-muted)]">
            Can't scan? Enter this key manually:
          </p>
          <code className="select-all rounded-input border border-[var(--border)] bg-[var(--bg)] px-3 py-1 font-mono text-xs tracking-wider">
            {totpPayload.secret}
          </code>
        </div>
        <Button
          variant="primary"
          className="mt-4 w-full"
          onClick={() => setStep("totp_verify")}
        >
          I've added it
        </Button>
      </Wrap>
    );
  }

  // -------------------- Step: TOTP — verify --------------------
  if (step === "totp_verify") {
    return (
      <Wrap
        heading="Confirm the code"
        subheading="Enter the 6-digit code your authenticator is showing now."
        onCancel={onCancel}
        onBack={() => setStep("totp_show")}
      >
        <CodeInput value={code} onChange={setCode} />
        {error && <ErrorBanner>{error}</ErrorBanner>}
        <Button
          variant="primary"
          className="mt-4 w-full"
          loading={busy}
          disabled={code.trim().length < 6}
          onClick={async () => {
            setError(null);
            setBusy(true);
            try {
              const payload = await api.verifyTotp(code.trim());
              setFinal(payload);
              setStep("backup");
            } catch (err) {
              setError(explainError(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          Verify and continue
        </Button>
      </Wrap>
    );
  }

  // -------------------- Step: Email — pick + send --------------------
  if (step === "email_send") {
    return (
      <Wrap
        heading="Send a code to your email"
        subheading="We'll send a 6-digit code to confirm you can read mail at this address."
        onCancel={onCancel}
        onBack={reset}
      >
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
            Email address
          </span>
          <input
            type="email"
            value={emailAddress}
            onChange={(e) => setEmailAddress(e.target.value)}
            placeholder="you@example.com"
            className="w-full rounded-input border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]/60"
          />
        </label>
        {error && <ErrorBanner>{error}</ErrorBanner>}
        <Button
          variant="primary"
          className="mt-4 w-full"
          loading={busy}
          disabled={!emailAddress.trim()}
          onClick={async () => {
            setError(null);
            setBusy(true);
            try {
              const payload = await api.beginEmail(emailAddress.trim());
              setEmailHint(payload.email_hint);
              setStep("email_verify");
            } catch (err) {
              setError(explainError(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          Send code
        </Button>
      </Wrap>
    );
  }

  // -------------------- Step: Email — verify --------------------
  if (step === "email_verify") {
    return (
      <Wrap
        heading="Enter the code"
        subheading={`We sent a 6-digit code to ${emailHint ?? "your inbox"}.`}
        onCancel={onCancel}
        onBack={() => setStep("email_send")}
      >
        <CodeInput value={code} onChange={setCode} />
        {error && <ErrorBanner>{error}</ErrorBanner>}
        <Button
          variant="primary"
          className="mt-4 w-full"
          loading={busy}
          disabled={code.trim().length < 6}
          onClick={async () => {
            setError(null);
            setBusy(true);
            try {
              const payload = await api.verifyEmail(code.trim());
              setFinal(payload);
              setStep("backup");
            } catch (err) {
              setError(explainError(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          Verify and continue
        </Button>
        <button
          type="button"
          onClick={async () => {
            setError(null);
            setBusy(true);
            try {
              const payload = await api.beginEmail(emailAddress.trim() || undefined);
              setEmailHint(payload.email_hint);
            } catch (err) {
              setError(explainError(err));
            } finally {
              setBusy(false);
            }
          }}
          disabled={busy}
          className="mt-3 block w-full text-center text-xs text-[var(--text-muted)] hover:text-[var(--text)] disabled:opacity-50"
        >
          Didn't get it? Resend code
        </button>
      </Wrap>
    );
  }

  // -------------------- Step: backup codes --------------------
  if (step === "backup" && final) {
    return (
      <Wrap
        heading="Save your backup codes"
        subheading="Each code can be used once if you lose access to your authenticator. Store them somewhere safe — they will not be shown again."
      >
        <BackupCodesPanel codes={final.backup_codes} />
        <Button
          variant="primary"
          className="mt-4 w-full"
          onClick={() => onComplete(final)}
        >
          I've saved my codes — continue
        </Button>
        <p className="mt-3 text-center text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
          Method enrolled: {final.method === "totp" ? "Authenticator app" : "Email"}
          {method ? ` (${method})` : ""}
        </p>
      </Wrap>
    );
  }

  // Unreachable, but keep TS happy.
  return null;
}

// =====================================================================
// Layout helpers
// =====================================================================
function Wrap({
  heading,
  subheading,
  children,
  onCancel,
  onBack,
}: {
  heading: string;
  subheading: string;
  children: React.ReactNode;
  onCancel?: () => void;
  onBack?: () => void;
}) {
  return (
    <div className="w-full max-w-md">
      <div className="mb-5 flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--accent)] text-white">
          <ShieldCheck className="h-4 w-4" />
        </div>
        <div>
          <h1 className="text-lg font-semibold tracking-tight">{heading}</h1>
          <p className="text-xs text-[var(--text-muted)]">{subheading}</p>
        </div>
      </div>
      <div className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-6 shadow-sm">
        {children}
      </div>
      {(onBack || onCancel) && (
        <div className="mt-4 flex items-center justify-between text-xs text-[var(--text-muted)]">
          {onBack ? (
            <button onClick={onBack} className="underline-offset-2 hover:underline">
              ← Back
            </button>
          ) : (
            <span />
          )}
          {onCancel && (
            <button
              onClick={onCancel}
              className="underline-offset-2 hover:underline"
            >
              Cancel
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function MethodCard({
  icon,
  title,
  description,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex items-start gap-3 rounded-card border border-[var(--border)] bg-[var(--bg)] p-4 text-left transition hover:border-[var(--accent)]/60 hover:bg-[var(--accent)]/5 disabled:opacity-60"
    >
      <div className="mt-0.5 text-[var(--accent)]">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{title}</div>
        <div className="mt-0.5 text-xs text-[var(--text-muted)]">
          {description}
        </div>
      </div>
    </button>
  );
}

function CodeInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <input
      autoFocus
      autoComplete="one-time-code"
      inputMode="numeric"
      pattern="[0-9]*"
      maxLength={6}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="123456"
      className="w-full rounded-input border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-center text-lg tracking-[0.5em] outline-none focus:border-[var(--accent)]/60"
    />
  );
}

function ErrorBanner({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="alert"
      className="mt-3 rounded-card border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400"
    >
      {children}
    </div>
  );
}
