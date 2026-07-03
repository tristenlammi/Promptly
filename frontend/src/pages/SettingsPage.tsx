import { Navigate } from "react-router-dom";

import { ProviderConnections } from "@/components/models/ProviderConnections";
import { useAuthStore } from "@/store/authStore";

/**
 * User-facing settings — the self-service BYOK surface. Every authenticated
 * user (not just platform admins) can add their own model providers here; the
 * backend scopes what they see and manage to their own providers.
 *
 * Kept intentionally lean for now (just Providers). Custom models / other
 * per-user settings can become tabs here later.
 */
export function SettingsPage() {
  const user = useAuthStore((s) => s.user);
  const canManageOrg = user?.role === "admin" || user?.org_role === "admin";
  // Members inherit the org's models and have no settings surface.
  if (!canManageOrg) return <Navigate to="/chat" replace />;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-lg font-semibold text-[var(--text)]">Settings</h1>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          Connect your own model providers. Promptly is bring-your-own-key —
          add an API key (OpenRouter, OpenAI, Anthropic, DeepSeek, Gemini, …) or
          point at your own server, and those models appear in your chat picker.
          Your keys are encrypted and only ever used for your own requests.
        </p>
      </header>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">
          Providers
        </h2>
        <ProviderConnections />
      </section>
    </div>
  );
}
