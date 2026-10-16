import { useState } from "react";
import { LogOut } from "lucide-react";

import { authApi } from "@/api/auth";
import { Button } from "@/components/shared/Button";
import { confirm } from "@/components/shared/ConfirmDialog";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

/** Sign out on every device — a lost phone, a shared computer. Only an
 *  admin could do this before (R-191). */
export function SignOutEverywherePanel() {
  const [busy, setBusy] = useState(false);

  const run = async () => {
    const ok = await confirm({
      title: "Sign out on every device?",
      message: "Every browser and app signed in to your account is signed out, this one included.",
      confirmLabel: "Sign out everywhere",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await authApi.logoutEverywhere();
      const { resetToLogin } = await import("@/lib/session");
      resetToLogin("everywhere");
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't sign out everywhere."));
      setBusy(false);
    }
  };

  return (
    <section className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-4">
      <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
        <LogOut className="h-4 w-4" /> Signed-in devices
      </h2>
      <p className="mb-3 text-xs text-[var(--text-muted)]">
        Lost a phone, or signed in on someone else's computer? Sign out
        everywhere, then sign back in here.
      </p>
      <Button variant="secondary" size="sm" loading={busy} onClick={() => void run()}>
        Sign out of all devices
      </Button>
    </section>
  );
}
