import { createContext, useContext, useEffect, useRef, type MutableRefObject, type ReactNode } from "react";

/**
 * How an open editor talks to the Ask panel (WP-5.5) without the page knowing
 * editor internals: the editor registers what's selected (and, for Docs, how
 * to insert an answer); the panel reads it when you ask. Tools inside an
 * editor (Sheets' "Explain formula") open the panel with a question.
 */
export interface EditorAiHooks {
  /** What's selected, as text the model can read — or null. */
  getSelection?: () => { label: string; text: string } | null;
  /** Put an answer (Markdown) into the file at the cursor. */
  insert?: (markdown: string) => void;
}

interface Bridge {
  hooks: MutableRefObject<EditorAiHooks>;
  ask: (question: string) => void;
}

const Ctx = createContext<Bridge | null>(null);

export function EditorAiBridgeProvider({ ask, children }: { ask: (question: string) => void; children: ReactNode }) {
  const hooks = useRef<EditorAiHooks>({});
  const askRef = useRef(ask);
  askRef.current = ask;
  const value = useRef<Bridge>({ hooks, ask: (q) => askRef.current(q) }).current;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The current editor's hooks, for the panel. */
export function useEditorAiHooks(): MutableRefObject<EditorAiHooks> | null {
  return useContext(Ctx)?.hooks ?? null;
}

/** Register this editor's hooks while it's mounted (outside a provider —
 *  a workspace pane — it's a no-op). Pass a stable-enough object; the latest
 *  one is always used. */
export function useRegisterEditorAi(hooks: EditorAiHooks): void {
  const ctx = useContext(Ctx);
  const latest = useRef(hooks);
  latest.current = hooks;
  useEffect(() => {
    if (!ctx) return;
    const proxy: EditorAiHooks = {
      getSelection: () => latest.current.getSelection?.() ?? null,
      insert: latest.current.insert ? (md) => latest.current.insert?.(md) : undefined,
    };
    ctx.hooks.current = proxy;
    return () => {
      if (ctx.hooks.current === proxy) ctx.hooks.current = {};
    };
  }, [ctx]);
}

/** Open the Ask panel with a question (null outside an editor page). */
export function useAskEditorAi(): ((question: string) => void) | null {
  return useContext(Ctx)?.ask ?? null;
}
