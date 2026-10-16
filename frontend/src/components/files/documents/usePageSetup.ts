import { useCallback, useEffect, useState } from "react";
import type * as Y from "yjs";

import {
  DEFAULT_PAGE_SETUP,
  PAGE_SETUP_KEY,
  pageCss,
  readPageSetup,
  writePageSetup,
  type PageSetup,
} from "@/lib/pageSetup";

/** The document's page setup, live from its Y.Doc (WP-6.4) — a
 *  collaborator's change arrives like any edit — plus a setter, and the
 *  browser's print CSS kept in step with it while the editor is open. */
export function usePageSetup(ydoc: Y.Doc | null): [PageSetup, (next: PageSetup) => void] {
  const [setup, setSetup] = useState<PageSetup>(() => (ydoc ? readPageSetup(ydoc) : DEFAULT_PAGE_SETUP));

  useEffect(() => {
    if (!ydoc) return;
    const map = ydoc.getMap(PAGE_SETUP_KEY);
    const update = () => setSetup(readPageSetup(ydoc));
    update();
    map.observe(update);
    return () => map.unobserve(update);
  }, [ydoc]);

  // Print in the light theme: a dark editor's light-on-dark text would
  // print pale on white paper.
  useEffect(() => {
    const root = document.documentElement;
    let wasDark = false;
    const before = () => {
      wasDark = root.classList.contains("dark");
      if (wasDark) root.classList.remove("dark");
    };
    const after = () => {
      if (wasDark) root.classList.add("dark");
      wasDark = false;
    };
    window.addEventListener("beforeprint", before);
    window.addEventListener("afterprint", after);
    return () => {
      window.removeEventListener("beforeprint", before);
      window.removeEventListener("afterprint", after);
      after();
    };
  }, []);

  useEffect(() => {
    const style = document.createElement("style");
    style.dataset.pageSetup = "";
    style.textContent = `@media print { ${pageCss(setup)} }`;
    document.head.appendChild(style);
    return () => style.remove();
  }, [setup]);

  const apply = useCallback(
    (next: PageSetup) => {
      if (ydoc) writePageSetup(ydoc, next);
    },
    [ydoc]
  );
  return [setup, apply];
}
