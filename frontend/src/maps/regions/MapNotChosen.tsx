import { Link } from "react-router-dom";

/** The Maps screen before any map has been chosen for this server. */
export function MapNotChosen({ isAdmin }: { isAdmin: boolean }) {
  return (
    <div data-testid="maps-not-chosen">
      <h1 className="text-lg font-semibold text-[var(--text)]">No map chosen yet</h1>
      <p className="mt-1 text-sm text-[var(--text-muted)]">
        {isAdmin
          ? "Choose which country's map this server keeps. Nothing is downloaded until you do."
          : "Your admin hasn't chosen a map for this server yet. Ask them to pick one."}
      </p>
      {isAdmin && (
        <Link
          to="/admin?tab=settings"
          className="mt-4 inline-flex h-10 items-center justify-center rounded-input bg-[var(--accent-strong)] px-4 text-sm font-medium text-white hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          Choose a map
        </Link>
      )}
    </div>
  );
}
