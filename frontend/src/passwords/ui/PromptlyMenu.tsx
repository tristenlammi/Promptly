// The button that opens Promptly's phone menu from the vault's own phone
// header. Kept apart from PromptlyNav.tsx (the sidebar itself) because the
// vault UI is also built into the extension and the desktop app, which never
// show Promptly's navigation and mustn't carry it: there's no provider there,
// so the slot draws nothing.
import { Menu } from "lucide-react";
import { createContext, useContext, useEffect } from "react";

export type PromptlyNavControls = {
  /** Slide Promptly's menu in. */
  open: () => void;
  /** The vault's header shows the button: no floating one. Returns the release. */
  claim: () => () => void;
};

export const PromptlyNavContext = createContext<PromptlyNavControls | null>(null);

/** Where the vault's phone header puts Promptly's menu button. Nothing
 *  outside Promptly (installed app, extension, desktop app). */
export function PromptlyMenuSlot() {
  const ctx = useContext(PromptlyNavContext);
  const claim = ctx?.claim;
  useEffect(() => claim?.(), [claim]);
  if (!ctx) return null;
  return <PromptlyMenuButton onClick={ctx.open} />;
}

/** Promptly's mark rather than a second ☰: the vault's own menu is right
 *  beside it on a phone. ``floating`` is the corner button on screens with no
 *  header (unlock, setup). */
export function PromptlyMenuButton({ onClick, floating = false }: { onClick: () => void; floating?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Open navigation menu"
      title="Promptly menu"
      className={`inline-flex h-9 shrink-0 items-center justify-center gap-1 rounded-md px-1 text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)] ${
        floating ? "border border-[var(--border)] bg-[var(--surface)] pr-2 shadow-sm" : ""
      }`}
    >
      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--accent)] text-white" aria-hidden>
        <span className="text-sm font-bold">P</span>
      </span>
      {floating && <Menu className="h-4 w-4" aria-hidden />}
    </button>
  );
}
