import { useState } from "react";
import { Link } from "react-router-dom";
import { ShieldAlert, X } from "lucide-react";

import { authApi } from "@/api/auth";
import type { AdminNoticeKind } from "@/api/types";
import { useAuthStore } from "@/store/authStore";
import { toast } from "@/store/toastStore";

const WHAT: Record<AdminNoticeKind, string> = {
  password_reset: "reset your password",
  email_changed: "changed your email address",
  role_changed: "changed your role",
  mfa_reset: "turned off your two-step verification",
  sso_linked: "linked single sign-on to your account",
};

/** "Your administrator reset your password on 9 Nov 2026." Shown once, on
 *  any device, after an admin changed this account (admin privacy AP5),
 *  until the person closes it. The email and notification say the same;
 *  Recent activity keeps the full list. */
export function AdminNoticeBanner() {
  const at = useAuthStore((s) => s.user?.admin_notice_at);
  const kind = useAuthStore((s) => s.user?.admin_notice_kind);
  const setUser = useAuthStore((s) => s.setUser);
  const [busy, setBusy] = useState(false);

  if (!at || !kind) return null;
  const date = new Date(at).toLocaleDateString(undefined, { dateStyle: "medium" });
  const what = WHAT[kind] ?? "changed your account";

  const dismiss = async () => {
    setBusy(true);
    try {
      setUser(await authApi.dismissAdminNotice());
    } catch {
      toast.error("Couldn't close that notice. Try again.");
      setBusy(false);
    }
  };

  return (
    <div
      role="status"
      className="flex items-start gap-2.5 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm text-amber-800 dark:text-amber-200"
    >
      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1">
        Your administrator {what} on {date}.{" "}
        <Link
          to="/account/privacy"
          className="font-medium underline underline-offset-2 hover:no-underline"
        >
          See recent activity
        </Link>
      </p>
      <button
        type="button"
        onClick={() => void dismiss()}
        disabled={busy}
        aria-label="Close this notice"
        className="-m-1 rounded p-1 hover:bg-amber-500/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-600 disabled:opacity-50"
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}
