import { type ReactNode } from "react";
import { PricingTable, useAuth } from "@clerk/clerk-react";

import { useAuthStore } from "@/store/authStore";
import { MemberSpinOff } from "./MemberSpinOff";

/**
 * Paywall for Clerk mode. A signed-in user *without* the `pro` entitlement
 * (i.e. on the free plan — no active subscription or trial) is blocked from the
 * app. Clerk treats an active free trial as entitled, so trialing users pass
 * straight through. Once they subscribe, `has()` flips to true and the app
 * renders.
 *
 * Two blocked audiences get different screens:
 *   - **org admin** (or a fresh signup who owns their auto-created org, or any
 *     non-member) → the org pricing table: they can subscribe / renew.
 *   - **member** whose org's subscription lapsed → they can't pay for someone
 *     else's org, so a bare pricing table is a dead end. They get
 *     {@link MemberSpinOff}: create their own org and continue on their own.
 *
 * This is the frontend gate. Backend hard-enforcement (so the API can't be
 * used without a subscription) is a follow-up, driven by Clerk billing
 * webhooks storing the plan on the shadow user.
 */
export function ClerkSubscriptionGate({ children }: { children: ReactNode }) {
  const { isLoaded, has, signOut } = useAuth();
  // Operators aren't customers — the platform operator bypasses the paywall.
  const isPlatformAdmin = useAuthStore(
    (s) => s.user?.is_platform_admin ?? s.user?.role === "admin"
  );
  // A confirmed *member* (org_role === "member") can't manage their org's
  // billing. Everyone else blocked (org admin, fresh signup, no-org/ambiguous)
  // gets the standard org pricing table — the safe default that avoids
  // spinning off a duplicate org for someone still being provisioned.
  const isMember = useAuthStore((s) => s.user?.org_role === "member");

  if (!isLoaded) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[var(--bg)] text-sm text-[var(--text-muted)]">
        Loading…
      </div>
    );
  }

  if (isPlatformAdmin) return <>{children}</>;
  const entitled = has?.({ feature: "pro" }) ?? false;
  if (entitled) return <>{children}</>;

  if (isMember) {
    return <MemberSpinOff onSignOut={() => signOut()} />;
  }

  return (
    <div className="min-h-screen w-screen overflow-y-auto bg-[var(--bg)] px-4 py-10">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-semibold text-[var(--text)]">
            Choose a plan to continue
          </h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Start your free trial— you won't be charged until it ends.
          </p>
        </div>
        {/* Bill the account's Organization (the tenant, seat-priced) — not the
            individual user. Every account is an org. */}
        <PricingTable for="organization" />
        <div className="mt-6 text-center">
          <button
            type="button"
            onClick={() => signOut()}
            className="text-sm text-[var(--text-muted)] transition hover:text-[var(--text)]"
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
