import { AlertTriangle, CheckCircle2, Circle, Loader2 } from "lucide-react";
import { Link } from "react-router-dom";

import type { SetupChecklist as Checklist, SetupRow } from "@/api/setup";
import { cn } from "@/utils/cn";

const GROUPS: { id: SetupRow["group"]; title: string; note: string }[] = [
  { id: "essential", title: "The assistant", note: "Needed before Promptly can answer or find things for you." },
  { id: "recommended", title: "Worth doing soon", note: "Promptly works without these, but a family will want them." },
  { id: "outside", title: "Outside Promptly", note: "Things only you can do, on your router." },
  { id: "extra", title: "Apps and extras", note: "What this server has switched on." },
];

/** "/setup?step=models" → "models"; anything else → null. */
export function stepOf(to: string | null): string | null {
  const m = to ? /^\/setup\?step=([a-z_]+)$/.exec(to) : null;
  return m ? m[1] : null;
}

function StatusIcon({ status }: { status: SetupRow["status"] }) {
  if (status === "done") return <CheckCircle2 className="h-5 w-5 text-emerald-600 dark:text-emerald-400" aria-label="Done" />;
  if (status === "working") return <Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" aria-label="Working on it" />;
  if (status === "problem") return <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400" aria-label="Needs a look" />;
  return <Circle className="h-5 w-5 text-[var(--text-muted)]" aria-label="Not done" />;
}

/**
 * The "Finish setting up" list: every row's status comes from the server.
 *
 * `onStep` is for the first-run wizard, where the app's own pages aren't
 * reachable yet: rows that are a wizard step call it, the rest show no
 * link. Everywhere else rows link straight to where the thing is done.
 */
export function SetupChecklist({
  data,
  onStep,
  compact = false,
}: {
  data: Checklist;
  onStep?: (step: string) => void;
  compact?: boolean;
}) {
  return (
    <div className="space-y-5" data-testid="setup-checklist">
      {GROUPS.map((g) => {
        const rows = data.rows.filter((r) => r.group === g.id);
        if (!rows.length) return null;
        return (
          <section key={g.id}>
            <h3 className="text-sm font-semibold text-[var(--text)]">{g.title}</h3>
            {!compact && <p className="mt-0.5 text-xs text-[var(--text-muted)]">{g.note}</p>}
            <ul className="mt-2 divide-y divide-[var(--border)] overflow-hidden rounded-card border border-[var(--border)] bg-[var(--surface)]">
              {rows.map((r) => (
                <li key={r.id} className="flex items-start gap-3 px-3 py-3" data-testid={`setup-row-${r.id}`} data-status={r.status}>
                  <span className="mt-0.5 shrink-0">
                    <StatusIcon status={r.status} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-[var(--text)]">{r.title}</div>
                    <p className="mt-0.5 text-xs leading-relaxed text-[var(--text-muted)]">{r.detail}</p>
                  </div>
                  <RowAction row={r} onStep={onStep} />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function RowAction({ row, onStep }: { row: SetupRow; onStep?: (step: string) => void }) {
  if (!row.to || !row.action) return null;
  const cls = cn(
    "shrink-0 self-center rounded-input border border-[var(--border)] px-3 py-1.5 text-xs font-medium",
    "text-[var(--text)] hover:bg-[var(--hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
  );
  const label = `${row.action}: ${row.title}`;
  if (onStep) {
    const step = stepOf(row.to);
    if (!step) return null;
    return (
      <button type="button" className={cls} aria-label={label} onClick={() => onStep(step)}>
        {row.action}
      </button>
    );
  }
  return (
    <Link to={row.to} className={cls} aria-label={label}>
      {row.action}
    </Link>
  );
}
