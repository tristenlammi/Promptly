import { OrgOnboardingWizard } from "./OrgOnboardingWizard";
import { authApi } from "@/api/auth";
import { isClerkAuth } from "@/auth/authMode";
import { useProviders } from "@/hooks/useProviders";
import { useAuthStore } from "@/store/authStore";

/**
 * Shows the {@link OrgOnboardingWizard} to a brand-new org admin, once.
 *
 * Eligibility (all must hold):
 *   - Clerk (hosted SaaS) mode — self-host uses the operator SetupPage.
 *   - The caller can manage the org (org admin), but is NOT the platform
 *     operator (they're already set up; their org is the ops tenant).
 *   - They haven't completed/skipped onboarding yet.
 *   - Their org has no providers wired up. This second signal means an
 *     existing, already-configured org never sees the wizard even though it
 *     predates the ``onboarding_completed`` flag.
 *
 * Finishing (or skipping any step) flips ``onboarding_completed`` — owned here
 * so a single code path guarantees the wizard never reappears.
 */
export function OrgOnboardingGate({ children }: { children: React.ReactNode }) {
  const canManageOrg = useAuthStore(
    (s) => s.user?.role === "admin" || s.user?.org_role === "admin"
  );
  const isPlatformAdmin = useAuthStore(
    (s) => s.user?.is_platform_admin ?? s.user?.role === "admin"
  );
  const completed = useAuthStore(
    (s) => !!s.user?.settings?.onboarding_completed
  );
  const patchSettings = useAuthStore((s) => s.patchSettings);
  const setUser = useAuthStore((s) => s.setUser);

  const maybeEligible =
    isClerkAuth && canManageOrg && !isPlatformAdmin && !completed;

  // Only hit the providers endpoint when we might actually gate.
  const { data: providers, isLoading } = useProviders(maybeEligible);

  if (!maybeEligible) return <>{children}</>;
  // Decide only once we know the provider state — avoids a flash of the app
  // before the wizard (or vice-versa).
  if (isLoading) return null;
  if ((providers ?? []).length > 0) return <>{children}</>;

  const markDone = () => {
    // Optimistic flip → the gate re-renders and drops the wizard immediately;
    // the persist follows in the background so a reload stays consistent.
    patchSettings({ onboarding_completed: true });
    authApi
      .updatePreferences({ onboarding_completed: true })
      .then(setUser)
      .catch(() => {
        /* optimistic flag already applied; a later /me will reconcile */
      });
  };

  return <OrgOnboardingWizard onDone={markDone} />;
}
