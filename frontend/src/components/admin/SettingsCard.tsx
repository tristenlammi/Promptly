import type { ReactNode } from "react";

/**
 * Shared visual chrome for admin-settings-style cards.
 *
 * Originally a local helper inside ``AppSettingsPanel.tsx``;
 * promoted to its own module so the new ``DefaultsTab`` (under
 * Admin → Models) can wear the same uniform — section title +
 * optional icon + footer button row — without forking the markup.
 *
 * Why a thin component instead of a Tailwind class chain in
 * every consumer: the title + footer + bordered surface layout
 * shows up enough across the admin surfaces that diverging
 * paddings, border colours, or radii would feel jarring. One
 * component keeps the look in lockstep.
 */
export function SettingsCard({
  title,
  icon,
  headerExtra,
  footer,
  children,
}: {
  title: string;
  icon?: ReactNode;
  headerExtra?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-card border border-[var(--border)] bg-[var(--surface)]">
      <header className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
        <div className="flex items-center gap-2">
          {icon && <span className="text-[var(--text-muted)]">{icon}</span>}
          <h3 className="text-sm font-semibold">{title}</h3>
        </div>
        {headerExtra}
      </header>
      <div className="px-4 py-4">{children}</div>
      {footer && (
        <footer className="flex items-center justify-end gap-2 border-t border-[var(--border)] px-4 py-3">
          {footer}
        </footer>
      )}
    </section>
  );
}
