import { Sparkles } from "lucide-react";

/**
 * Visual celebration shown when the tutor emits ``<celebrate/>``.
 * Fires on a genuine aha — the student committed a correct prediction or
 * explained a concept cleanly on the first try. Used sparingly (once or
 * twice per unit at most) so it keeps its weight.
 */
export function AhaMoment() {
  return (
    <div className="mx-1 mb-3 flex items-center gap-3 rounded-lg border border-[var(--accent)]/35 bg-[var(--accent)]/10 px-4 py-3 shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_8%,transparent)] animate-in fade-in zoom-in-95 duration-500 ease-out">
      {/* Pulsing icon ring — fires twice then settles */}
      <div className="relative flex h-9 w-9 shrink-0 items-center justify-center">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--accent)]/20 [animation-iteration-count:2]" />
        <div className="relative flex h-9 w-9 items-center justify-center rounded-full bg-[var(--accent)]/20">
          <Sparkles className="h-4 w-4 text-[var(--accent)]" />
        </div>
      </div>
      <div>
        <p className="text-sm font-semibold text-[var(--accent)]">You got it!</p>
        <p className="text-[11px] text-[var(--text-muted)]">First-try understanding — that's the goal.</p>
      </div>
    </div>
  );
}
