import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import { Check, ChevronDown, PenLine, X } from "lucide-react";

import { cn } from "@/utils/cn";

import { Menu, useAnchoredMenu } from "./ToolbarExtras";

import { SUGGESTION_CLICK_EVENT, countSuggestions, type SuggestionClick } from "./SuggestionExtension";

/** The toolbar's Editing / Suggesting switch (Stage 6 suggestion mode),
 *  how many suggestions there are, and accept- or reject-all. */
export function SuggestionModeControl({ editor, disabled }: { editor: Editor | null; disabled?: boolean }) {
  const [on, setOn] = useState(false);
  const [count, setCount] = useState(0);
  const menu = useAnchoredMenu();
  useEffect(() => {
    if (!editor) return;
    const update = () => setCount(countSuggestions(editor.state.doc));
    update();
    editor.on("update", update);
    return () => {
      editor.off("update", update);
    };
  }, [editor]);
  const toggle = (next: boolean) => {
    setOn(next);
    editor?.commands.setSuggesting(next);
  };
  return (
    <div className="relative flex items-center">
      <button
        type="button"
        disabled={disabled || !editor}
        aria-haspopup="menu"
        aria-expanded={!!menu.anchor}
        aria-label={`${on ? "Suggesting — your edits are suggestions" : "Editing"}${count ? `, ${count} ${count === 1 ? "suggestion" : "suggestions"}` : ""}`}
        onClick={menu.toggle}
        className={cn(
          "flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium transition disabled:opacity-50",
          on ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : "text-[var(--text-muted)] hover:bg-[var(--hover)]",
        )}
      >
        <PenLine className="h-3.5 w-3.5" />
        {on ? "Suggesting" : "Editing"}
        {count > 0 && <span className="rounded-full bg-[var(--hover)] px-1.5 tabular-nums">{count}</span>}
        <ChevronDown className="h-3 w-3" />
      </button>
      {menu.anchor && (
        <Menu anchor={menu.anchor} label="Suggestions" onClose={menu.close} width={256}>
          <button type="button" role="menuitemradio" aria-checked={!on} onClick={() => { toggle(false); menu.close(); }}
            className="block w-full px-3 py-1.5 text-left hover:bg-[var(--hover)]">
            <span className="font-medium">Editing</span>
            <span className="block text-xs text-[var(--text-muted)]">Change the document directly.</span>
          </button>
          <button type="button" role="menuitemradio" aria-checked={on} onClick={() => { toggle(true); menu.close(); }}
            className="block w-full px-3 py-1.5 text-left hover:bg-[var(--hover)]">
            <span className="font-medium">Suggesting</span>
            <span className="block text-xs text-[var(--text-muted)]">Your edits become suggestions to accept or reject.</span>
          </button>
          <div className="my-1 border-t border-[var(--border)]" />
          <button type="button" role="menuitem" disabled={!count} onClick={() => { editor?.chain().focus().acceptAllSuggestions().run(); menu.close(); }}
            className="block w-full px-3 py-1.5 text-left hover:bg-[var(--hover)] disabled:opacity-50">
            Accept all suggestions{count ? ` (${count})` : ""}
          </button>
          <button type="button" role="menuitem" disabled={!count} onClick={() => { editor?.chain().focus().rejectAllSuggestions().run(); menu.close(); }}
            className="block w-full px-3 py-1.5 text-left hover:bg-[var(--hover)] disabled:opacity-50">
            Reject all suggestions
          </button>
        </Menu>
      )}
    </div>
  );
}

/** The bubble a click on a suggestion opens: who, when, accept / reject. */
export function SuggestionBubble({ editor, canResolve }: { editor: Editor | null; canResolve: boolean }) {
  const [open, setOpen] = useState<SuggestionClick | null>(null);
  useEffect(() => {
    const onClick = (e: Event) => setOpen((e as CustomEvent<SuggestionClick>).detail);
    document.addEventListener(SUGGESTION_CLICK_EVENT, onClick);
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement)?.closest?.("[data-suggestion-bubble], [data-suggest]")) setOpen(null);
    };
    document.addEventListener("mousedown", close);
    return () => {
      document.removeEventListener(SUGGESTION_CLICK_EVENT, onClick);
      document.removeEventListener("mousedown", close);
    };
  }, []);
  if (!open || !editor) return null;
  const when = open.at ? new Date(open.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";
  const act = (accept: boolean) => {
    if (accept) editor.chain().focus().acceptSuggestion(open.id).run();
    else editor.chain().focus().rejectSuggestion(open.id).run();
    setOpen(null);
  };
  return createPortal(
    <div data-suggestion-bubble role="dialog" aria-label="Suggestion"
      className="fixed z-50 w-60 rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-xs shadow-lg"
      style={{ left: Math.min(open.rect.left, window.innerWidth - 250), top: open.rect.bottom + 6 }}>
      <p className="text-[var(--text)]">
        <span className="font-medium">{open.author || "Someone"}</span> suggested {open.kind === "ins" ? "adding this" : "deleting this"}
      </p>
      {when && <p className="text-[var(--text-muted)]">{when}</p>}
      {canResolve && (
        <div className="mt-2 flex gap-1">
          <button type="button" onClick={() => act(true)} className="flex flex-1 items-center justify-center gap-1 rounded bg-emerald-600 py-1 text-white hover:opacity-90">
            <Check className="h-3.5 w-3.5" /> Accept
          </button>
          <button type="button" onClick={() => act(false)} className="flex flex-1 items-center justify-center gap-1 rounded border border-[var(--border)] py-1 hover:bg-[var(--hover)]">
            <X className="h-3.5 w-3.5" /> Reject
          </button>
        </div>
      )}
    </div>,
    document.body,
  );
}
