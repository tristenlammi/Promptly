import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ListChecks, X } from "lucide-react";
import { Link } from "react-router-dom";

import { authApi } from "@/api/auth";
import { SETUP_QUERY_KEY, setupApi, type SetupChecklist, type SetupRow } from "@/api/setup";
import { useAuthStore } from "@/store/authStore";

const ORDER: SetupRow["group"][] = ["essential", "recommended", "outside", "extra"];

/**
 * Today's "Finish setting up" card, for admins: what a skipped or
 * half-done setup still needs, read from the server. It goes away when
 * nothing is left, or for good on × (the list stays in Admin → Setup).
 */
export function SetupCard() {
  const isAdmin = useAuthStore((s) => s.user?.role === "admin");
  const setUser = useAuthStore((s) => s.setUser);
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: SETUP_QUERY_KEY,
    queryFn: setupApi.checklist,
    enabled: isAdmin,
    staleTime: 60_000,
  });
  if (!isAdmin || !data || data.dismissed || data.left === 0) return null;

  const todo = data.rows
    .filter((r) => r.status === "todo" || r.status === "problem")
    .sort((a, b) => ORDER.indexOf(a.group) - ORDER.indexOf(b.group));
  const shown = todo.slice(0, 3);

  const dismiss = async () => {
    qc.setQueryData<SetupChecklist>(SETUP_QUERY_KEY, { ...data, dismissed: true });
    try {
      setUser(await authApi.updatePreferences({ setup_card_dismissed: true }));
    } catch {
      // Not saved: it comes back next time, which is the honest outcome.
      void qc.invalidateQueries({ queryKey: SETUP_QUERY_KEY });
    }
  };

  return (
    <section
      className="mb-4 rounded-card border border-[var(--accent)]/40 bg-[var(--surface)] px-4 py-3"
      data-testid="today-setup-card"
      aria-label="Finish setting up Promptly"
    >
      <div className="flex items-start gap-3">
        <ListChecks className="mt-0.5 h-5 w-5 shrink-0 text-[var(--accent-text)]" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-[var(--text)]">Finish setting up Promptly</h2>
          <p className="mt-0.5 text-xs text-[var(--text-muted)]">
            {data.done} of {data.total} done.
            {data.essential_left > 0 ? " The assistant can't help yet." : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void dismiss()}
          aria-label="Hide this (the list stays in Admin, under Setup)"
          title="Hide this (the list stays in Admin, under Setup)"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--hover)]"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <ul className="mt-2 space-y-1.5 sm:pl-8">
        {shown.map((r) => (
          <li key={r.id} className="flex items-center gap-3 text-sm">
            <span className="min-w-0 flex-1 truncate text-[var(--text)]">{r.title}</span>
            {r.to && r.action && (
              <Link
                to={r.to}
                aria-label={`${r.action}: ${r.title}`}
                className="shrink-0 rounded-input border border-[var(--border)] px-2.5 py-1 text-xs font-medium text-[var(--text)] hover:bg-[var(--hover)]"
              >
                {r.action}
              </Link>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-2 sm:pl-8">
        <Link to="/admin?tab=setup" className="text-xs font-medium text-[var(--accent-text)] hover:underline">
          {todo.length > shown.length ? `See all ${todo.length} things left` : "See the whole list"}
        </Link>
      </div>
    </section>
  );
}
