/**
 * Shared empty-state card: dashed border, centered icon-in-circle, title,
 * one-liner, optional call-to-action. Promoted from the Files surface's
 * ``DriveEmptyState`` (which now re-exports this) so Archive, Tasks, and
 * every future surface greet an empty list the same way instead of
 * hand-rolling variants.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  description: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-card border border-dashed border-[var(--border)] bg-[var(--surface)] px-6 py-12 text-center">
      {icon && (
        <div className="mx-auto mb-3 inline-flex h-10 w-10 items-center justify-center rounded-full bg-[var(--bg)] text-[var(--text-muted)]">
          {icon}
        </div>
      )}
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="mx-auto mt-1 max-w-md text-sm text-[var(--text-muted)]">
        {description}
      </p>
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}
