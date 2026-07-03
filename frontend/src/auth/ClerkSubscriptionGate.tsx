import { type ReactNode } from "react";
import { PricingTable, useAuth } from "@clerk/clerk-react";

/**
 * Paywall for Clerk mode. A signed-in user *without* the `pro` entitlement
 * (i.e. on the free plan — no active Personal Plan or trial) sees Clerk's
 * pricing table instead of the app. Clerk treats an active free trial as
 * entitled, so trialing users pass straight through. Once they subscribe,
 * `has()` flips to true and the app renders.
 *
 * This is the frontend gate. Backend hard-enforcement (so the API can't be
 * used without a subscription) is a follow-up, driven by Clerk billing
 * webhooks storing the plan on the shadow user.
 */
export function ClerkSubscriptionGate({ children }: { children: ReactNode }) {
  const { isLoaded, has, signOut } = useAuth();

  if (!isLoaded) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[var(--bg)] text-sm text-[var(--text-muted)]">
        Loading…
      </div>
    );
  }

  const entitled = has?.({ feature: "pro" }) ?? false;
  if (entitled) return <>{children}</>;

  return (
    <div className="min-h-screen w-screen overflow-y-auto bg-[var(--bg)] px-4 py-10">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-semibold text-[var(--text)]">
            Choose a plan to continue
          </h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Start your 7-day free trial — you won't be charged until it ends.
          </p>
        </div>
        <PricingTable />
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
