import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";

import { authApi } from "@/api/auth";
import { SETUP_QUERY_KEY, setupApi } from "@/api/setup";
import { Button } from "@/components/shared/Button";
import { SetupChecklist } from "@/components/setup/SetupChecklist";
import { useAuthStore } from "@/store/authStore";

/**
 * Admin → Setup: the "Finish setting up" list, for good. Every row is
 * checked against the server each time the page loads, and links to the
 * setup step or admin page where it's done.
 */
export function SetupPanel() {
  const qc = useQueryClient();
  const setUser = useAuthStore((s) => s.setUser);
  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: SETUP_QUERY_KEY,
    queryFn: setupApi.checklist,
    // A map build or a test call moves by itself.
    refetchInterval: 30_000,
  });

  if (isLoading) return <div className="text-sm text-[var(--text-muted)]">Checking what's set up…</div>;
  if (isError || !data) {
    return (
      <div className="text-sm text-red-600 dark:text-red-400">
        Couldn't check the setup. Refresh and try again.
      </div>
    );
  }

  const showAgain = async () => {
    setUser(await authApi.updatePreferences({ setup_card_dismissed: false }));
    await qc.invalidateQueries({ queryKey: SETUP_QUERY_KEY });
  };

  return (
    <div className="max-w-3xl space-y-5" data-testid="setup-panel">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">
            {data.left === 0 ? "Everything is set up" : `${data.done} of ${data.total} set up`}
          </h2>
          <p className="mt-0.5 text-xs text-[var(--text-muted)]">
            What Promptly needs to work for your family, checked against this server just now.
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void refetch()}
          loading={isFetching}
          leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
        >
          Check again
        </Button>
      </header>
      <SetupChecklist data={data} />
      {data.dismissed && data.left > 0 && (
        <p className="text-xs text-[var(--text-muted)]">
          You closed the reminder on Today.{" "}
          <button type="button" onClick={() => void showAgain()} className="font-medium text-[var(--accent-text)] hover:underline">
            Show it again
          </button>
        </p>
      )}
    </div>
  );
}
