import { useMemo, useState } from "react";
import { ListPlus, X } from "lucide-react";

import type { StudyUnitSummary } from "@/api/types";

/** localStorage prefix for dismissed prereq batches. Keyed by project
 *  id + batch id so dismissing one batch doesn't hide others, and so
 *  that the user can reset by clearing site data if needed. */
const DISMISSED_KEY_PREFIX = "promptly:study:prereq_batch_dismissed:";

function dismissedKey(projectId: string, batchId: string): string {
  return `${DISMISSED_KEY_PREFIX}${projectId}:${batchId}`;
}

function readDismissed(projectId: string, batchId: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(dismissedKey(projectId, batchId)) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(projectId: string, batchId: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(dismissedKey(projectId, batchId), "1");
  } catch {
    // localStorage may be unavailable in private mode; ignore.
  }
}

/** Group of units inserted in the same tutor reply. */
interface PrereqBatch {
  batchId: string;
  reason: string | null;
  units: StudyUnitSummary[];
}

/** Group tutor-inserted units by ``prereq_batch_id``. Units missing a
 *  batch id (older inserts before Phase-2.5) are skipped — there's no
 *  grouping key to dedupe on and the UnitCard chip still surfaces them
 *  individually. */
function groupByBatch(units: StudyUnitSummary[]): PrereqBatch[] {
  const map = new Map<string, PrereqBatch>();
  for (const u of units) {
    if (!u.inserted_as_prereq || !u.prereq_batch_id) continue;
    const existing = map.get(u.prereq_batch_id);
    if (existing) {
      existing.units.push(u);
      if (!existing.reason && u.prereq_reason) {
        existing.reason = u.prereq_reason;
      }
    } else {
      map.set(u.prereq_batch_id, {
        batchId: u.prereq_batch_id,
        reason: u.prereq_reason,
        units: [u],
      });
    }
  }
  for (const batch of map.values()) {
    batch.units.sort((a, b) => a.order_index - b.order_index);
  }
  return Array.from(map.values()).sort(
    (a, b) =>
      (a.units[0]?.order_index ?? 0) - (b.units[0]?.order_index ?? 0)
  );
}

/** Self-explanatory banner on the topic page for tutor-inserted
 *  prerequisite unit batches. Shows the reason the tutor supplied plus
 *  the list of units it added, and remembers dismissal in
 *  ``localStorage`` so it doesn't nag across reloads — once the user
 *  closes it for a batch, it stays gone for that batch. Regenerating
 *  the plan wipes the units entirely, so the stale dismissal key
 *  simply never matches again. */
export function PrereqBatchBanner({
  projectId,
  units,
}: {
  projectId: string;
  units: StudyUnitSummary[];
}) {
  const batches = useMemo(() => groupByBatch(units), [units]);

  // Track dismissed batches in state so we can react immediately on
  // click without waiting for a re-render from the parent.
  const [dismissed, setDismissed] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    for (const batch of batches) {
      if (readDismissed(projectId, batch.batchId)) {
        initial[batch.batchId] = true;
      }
    }
    return initial;
  });

  const visible = batches.filter((b) => !dismissed[b.batchId]);
  if (visible.length === 0) return null;

  return (
    <div className="mt-4 space-y-2">
      {visible.map((batch) => (
        <div
          key={batch.batchId}
          role="status"
          className="flex items-start gap-3 rounded-card border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
        >
          <div className="mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-full bg-amber-500/20 text-amber-700 dark:text-amber-300">
            <ListPlus className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-medium text-amber-800 dark:text-amber-200">
              {batch.units.length === 1
                ? "Your tutor added a prerequisite unit"
                : `Your tutor added ${batch.units.length} prerequisite units`}
            </div>
            {batch.reason && (
              <div className="mt-0.5 text-xs text-[var(--text-muted)]">
                {batch.reason}
              </div>
            )}
            <ul className="mt-1.5 space-y-0.5 text-xs text-[var(--text-muted)]">
              {batch.units.map((u) => (
                <li key={u.id} className="line-clamp-1">
                  • Unit {u.order_index + 1} — {u.title}
                </li>
              ))}
            </ul>
          </div>
          <button
            onClick={() => {
              writeDismissed(projectId, batch.batchId);
              setDismissed((prev) => ({ ...prev, [batch.batchId]: true }));
            }}
            aria-label="Dismiss"
            title="Dismiss"
            className="text-[var(--text-muted)] transition hover:text-[var(--text)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
