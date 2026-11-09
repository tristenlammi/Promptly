import { createContext, useContext } from "react";

import type { Bootstrap } from "@/api/porch";

/** What every Porch page needs to know about where it's drawn. */
export interface PorchCtx {
  /** Phone layout: full screen, bottom bar. */
  isPhone: boolean;
  /** Inside Promptly's own layout (a big screen): its sidebar is right there. */
  embedded: boolean;
  /** Full screen inside Promptly on a phone (not the installed Porch app):
   *  the page headers carry Promptly's menu button. */
  promptlyNav: boolean;
  /** Bootstrap: you, your groups and invites (always loaded once a page draws). */
  b: Bootstrap;
}

export const PorchContext = createContext<PorchCtx>({ isPhone: false, embedded: false, promptlyNav: false, b: null as unknown as Bootstrap });

export function usePorch(): PorchCtx {
  return useContext(PorchContext);
}
