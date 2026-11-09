import { createContext, useContext } from "react";

import type { Bootstrap } from "@/api/porch";

/** What every Porch page needs to know about where it's drawn. */
export interface PorchCtx {
  /** Phone layout: full screen, bottom bar. */
  isPhone: boolean;
  /** Inside Promptly's own layout (a desktop browser): its sidebar is right there. */
  embedded: boolean;
  /** Bootstrap: you, your groups and invites (always loaded once a page draws). */
  b: Bootstrap;
}

export const PorchContext = createContext<PorchCtx>({ isPhone: false, embedded: false, b: null as unknown as Bootstrap });

export function usePorch(): PorchCtx {
  return useContext(PorchContext);
}

/** Running as an installed app (no browser chrome, no "Back to Promptly" needed). */
export function isStandalone(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(display-mode: standalone)").matches;
}
