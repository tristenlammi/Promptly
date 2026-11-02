import { Check } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";

import type { EditScope, RsvpStatus } from "@/api/calendar";
import { ItemButton, Sheet } from "@/items/ui";
import { cn } from "@/utils/cn";

import { PALETTE, STATUS_LABEL } from "../model";

export function StatusBadge({ status }: { status: RsvpStatus }) {
  const tone: Record<RsvpStatus, string> = {
    going: "bg-[color-mix(in_srgb,#3E8E5A_16%,transparent)] text-[#2f7a48] dark:text-[#7fd09a]",
    maybe: "bg-[color-mix(in_srgb,#C08B2C_18%,transparent)] text-[#9a6c12] dark:text-[#e2b65e]",
    declined: "bg-[color-mix(in_srgb,var(--danger)_14%,transparent)] text-[var(--danger)]",
    invited: "bg-[var(--surface-2)] text-[var(--text-muted)]",
  };
  return <span className={cn("inline-flex h-5 items-center rounded-full px-2 text-[11px] font-medium", tone[status])}>{STATUS_LABEL[status]}</span>;
}

/** Going / Maybe / Can't go. */
export function RsvpButtons({
  value,
  onAnswer,
  busy,
  size = "md",
}: {
  value: RsvpStatus | null;
  onAnswer: (s: Exclude<RsvpStatus, "invited">) => void;
  busy?: boolean;
  size?: "sm" | "md";
}) {
  const opts: [Exclude<RsvpStatus, "invited">, string][] = [
    ["going", "Going"],
    ["maybe", "Maybe"],
    ["declined", size === "sm" ? "No" : "Can't go"],
  ];
  return (
    <div role="radiogroup" aria-label="Your answer" className="flex gap-1.5">
      {opts.map(([s, label]) => (
        <button
          key={s}
          type="button"
          role="radio"
          aria-checked={value === s}
          disabled={busy}
          onClick={() => onAnswer(s)}
          className={cn(
            "inline-flex flex-1 items-center justify-center gap-1 rounded-xl border font-medium transition disabled:opacity-50",
            size === "sm" ? "h-7 px-2 text-xs" : "h-10 px-3 text-sm",
            value === s
              ? "border-[var(--item-accent)] bg-[color-mix(in_srgb,var(--item-accent)_14%,transparent)] text-[var(--text)]"
              : "border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]",
          )}
        >
          {value === s && <Check className="h-3.5 w-3.5" />}
          {label}
        </button>
      ))}
    </div>
  );
}

export function Swatches({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div role="radiogroup" aria-label="Colour" className="flex flex-wrap gap-2">
      {PALETTE.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value.toLowerCase() === c.toLowerCase()}
          aria-label={c}
          onClick={() => onChange(c)}
          className="flex h-8 w-8 items-center justify-center rounded-full ring-offset-2 ring-offset-[var(--bg)] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]"
          style={{ background: c }}
        >
          {value.toLowerCase() === c.toLowerCase() && <Check className="h-4 w-4 text-white" />}
        </button>
      ))}
    </div>
  );
}

/** A floating card next to ``anchor`` (desktop). Escape / outside click closes.
 *  Sits under confirm dialogs / sheets it opens (``z``); raise it over a sheet it's opened from. */
export function Popover({ anchor, onClose, children, width = 360, z = 45 }: { anchor: DOMRect; onClose: () => void; children: ReactNode; width?: number; z?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Beside the anchor (right, else left), else centred over it.
    let left = anchor.right + 8;
    if (left + width > vw - 12) left = anchor.left - width - 8;
    if (left < 12) left = Math.min(vw - width - 12, Math.max(12, anchor.left + anchor.width / 2 - width / 2));
    const top = Math.min(vh - h - 12, Math.max(12, anchor.top - 8));
    setPos({ left, top });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor.left, anchor.top, anchor.right, anchor.width, width]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A sheet opened from the popover handles its own Escape.
      if (e.key === "Escape" && !document.querySelector('[role="dialog"][aria-modal="true"]')) closeRef.current();
    };
    // Sheets already open (the popover sits on one) don't count as "inside";
    // ones opened from the popover (a confirm, the editor) do.
    const before = new Set(document.querySelectorAll('[role="dialog"][aria-modal="true"]'));
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      const modal = t.closest('[role="dialog"][aria-modal="true"]');
      if (ref.current?.contains(t) || (modal && !before.has(modal)) || t.closest("[data-cal-keep-popover]")) return;
      closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, []);

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-modal="false"
      style={{ width, left: pos?.left ?? -9999, top: pos?.top ?? 0, zIndex: z }}
      className="fixed max-h-[calc(100dvh-24px)] overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--bg)] shadow-[var(--shadow-lg)] animate-[fadeIn_100ms_ease-out]"
    >
      {children}
    </div>,
    document.body,
  );
}

// ------------------------------------------------------------------ scope

interface ScopeAsk {
  verb: "edit" | "delete";
  allowThis: boolean;
  resolve: (s: EditScope | null) => void;
}
const useScopeAsk = create<{ ask: ScopeAsk | null; set: (a: ScopeAsk | null) => void }>((set) => ({ ask: null, set: (ask) => set({ ask }) }));

/** "This event / This and following / All events" for a repeating event. */
export function askScope(verb: "edit" | "delete", allowThis = true): Promise<EditScope | null> {
  return new Promise((resolve) => useScopeAsk.getState().set({ verb, allowThis, resolve }));
}

export function ScopeHost() {
  const ask = useScopeAsk((s) => s.ask);
  const set = useScopeAsk((s) => s.set);
  const [choice, setChoice] = useState<EditScope>("this");
  useEffect(() => {
    if (ask) setChoice(ask.allowThis ? "this" : "following");
  }, [ask]);
  const done = (s: EditScope | null) => {
    ask?.resolve(s);
    set(null);
  };
  const opts: [EditScope, string][] = [
    ...(ask?.allowThis ? ([["this", "This event"]] as [EditScope, string][]) : []),
    ["following", "This and following events"],
    ["all", "All events"],
  ];
  return (
    <Sheet
      open={!!ask}
      onClose={() => done(null)}
      title={ask?.verb === "delete" ? "Delete repeating event" : "Change repeating event"}
      size="sm"
      footer={
        <>
          <ItemButton block onClick={() => done(null)}>
            Cancel
          </ItemButton>
          <ItemButton block variant={ask?.verb === "delete" ? "danger" : "primary"} onClick={() => done(choice)}>
            {ask?.verb === "delete" ? "Delete" : "Save"}
          </ItemButton>
        </>
      }
    >
      <div role="radiogroup" className="flex flex-col gap-1 py-1">
        {opts.map(([v, label]) => (
          <label key={v} className="flex h-11 cursor-pointer items-center gap-3 rounded-xl px-2 text-sm text-[var(--text)] hover:bg-[var(--hover)]">
            <input type="radio" name="cal-scope" checked={choice === v} onChange={() => setChoice(v)} className="h-4 w-4 accent-[var(--item-accent)]" />
            {label}
          </label>
        ))}
      </div>
    </Sheet>
  );
}
