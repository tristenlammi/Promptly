import { Navigate, useNavigate } from "react-router-dom";

import { mfaApi } from "@/api/mfa";
import { EnrollmentWizard } from "@/components/mfa/EnrollmentWizard";
import { useAuthStore } from "@/store/authStore";

/** Forced-enrollment screen — reached after a password OK when the
 * global ``mfa_required`` setting is on and the user has no method.
 *
 * Hands the wizard the ``...forced`` API methods so each network call
 * carries the short-lived enrollment token (rather than the access
 * token the user doesn't have yet). On completion the wizard returns
 * the freshly-issued access token + user, which we drop straight into
 * the auth store. */
export function MfaEnrollPage() {
  const pendingMfa = useAuthStore((s) => s.pendingMfa);
  const loginSuccess = useAuthStore((s) => s.loginSuccess);
  const clear = useAuthStore((s) => s.clear);
  const navigate = useNavigate();

  if (!pendingMfa || pendingMfa.kind !== "enrollment") {
    return <Navigate to="/login" replace />;
  }
  const token = pendingMfa.token;

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg)] px-4 text-[var(--text)]">
      <EnrollmentWizard
        api={{
          beginTotp: () => mfaApi.forcedBeginTotp(token),
          verifyTotp: (code) => mfaApi.forcedVerifyTotp(token, code),
          beginEmail: (addr) => mfaApi.forcedBeginEmail(token, addr),
          verifyEmail: (code) => mfaApi.forcedVerifyEmail(token, code),
        }}
        heading="Set up two-step verification"
        subheading="Your administrator requires two-factor authentication on every account."
        onComplete={(payload) => {
          loginSuccess(payload.user, payload.access_token);
          navigate("/chat", { replace: true });
        }}
        onCancel={() => {
          clear();
          navigate("/login", { replace: true });
        }}
      />
    </div>
  );
}
