import { CreateOrganization } from "@clerk/clerk-react";

/**
 * Shown to a **member** whose organisation's subscription has lapsed.
 *
 * A member can't pay for someone else's org, so the normal org pricing table is
 * a dead end for them. Instead we offer a clean spin-off: create their own
 * organisation (Clerk makes them its admin and sets it active). On the next
 * render they own a provider-less, subscription-less org, so the gate falls
 * through to the org pricing table for *their* org — they subscribe and they're
 * in, then the onboarding wizard walks them through adding a key.
 *
 * Their own content follows them automatically: chats, files and workspaces are
 * keyed to their user, not the org. Org-inherited config (providers, models,
 * connectors, groups) is org-scoped, so it's correctly left behind.
 */
export function MemberSpinOff({ onSignOut }: { onSignOut: () => void }) {
  return (
    <div className="min-h-screen w-screen overflow-y-auto bg-[var(--bg)] px-4 py-10">
      <div className="mx-auto max-w-lg">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-semibold text-[var(--text)]">
            Your organisation's subscription has ended
          </h1>
          <p className="mx-auto mt-2 max-w-md text-sm text-[var(--text-muted)]">
            To keep using Promptly, continue on your own account. You'll keep the
            chats, files and workspaces <strong>you</strong> created — shared team
            content stays with your organisation. Start by creating your own
            workspace below, then pick a plan.
          </p>
        </div>

        <div className="flex justify-center">
          <CreateOrganization
            afterCreateOrganizationUrl="/"
            skipInvitationScreen
          />
        </div>

        <div className="mt-6 text-center">
          <button
            type="button"
            onClick={onSignOut}
            className="text-sm text-[var(--text-muted)] transition hover:text-[var(--text)]"
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
