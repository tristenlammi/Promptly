import { Delete } from "lucide-react";
import { useEffect, useState } from "react";

import { ItemButton, Segmented, Sheet } from "@/items/ui";
import { cn } from "@/utils/cn";

import { fmtScore } from "./bits";

/** What the pad decided: a value to set, or an amount to add to whatever
 *  is there when the change lands (worked out from the file, not the
 *  screen, so two phones adding at once both count). */
export type PadChange = { mode: "set"; value: number | null } | { mode: "add"; value: number };

/**
 * The big number pad for passing the phone around: set or add, ±, a decimal
 * point, quick values (Yahtzee's 25 / 30 / 40), "Save & next" to hand it on.
 */
export function NumPad({
  open,
  onClose,
  title,
  subtitle,
  current,
  options,
  onSave,
  nextLabel,
  allowAdd = true,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  current: number | null;
  options?: number[];
  onSave: (change: PadChange, next: boolean) => void;
  nextLabel?: string;
  allowAdd?: boolean;
}) {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"set" | "add">("set");
  useEffect(() => {
    if (open) {
      setText("");
      setMode("set");
    }
  }, [open, title]);

  const typed = text === "" || text === "-" ? null : Number(text);
  const result = typed === null ? (mode === "set" ? null : current) : mode === "add" ? (current ?? 0) + typed : typed;

  const press = (k: string) => {
    setText((t) => {
      if (k === "back") return t.slice(0, -1);
      if (k === "neg") return t.startsWith("-") ? t.slice(1) : `-${t}`;
      if (k === ".") return t.includes(".") ? t : t === "" ? "0." : t === "-" ? "-0." : `${t}.`;
      if (t.replace("-", "").length >= 7) return t;
      if (t === "0") return k;
      if (t === "-0") return `-${k}`;
      return t + k;
    });
  };

  // Typing on a keyboard works too.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (/^[0-9]$/.test(e.key)) press(e.key);
      else if (e.key === "Backspace") press("back");
      else if (e.key === "-") press("neg");
      else if (e.key === "." || e.key === ",") press(".");
      else if (e.key === "Enter") {
        e.preventDefault();
        save(!!nextLabel);
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const save = (next: boolean) => {
    if (typed === null || !Number.isFinite(typed)) {
      // Nothing typed: keep what's there (and move on).
      onSave({ mode: "add", value: 0 }, next);
      return;
    }
    const v = Math.round(typed * 10000) / 10000;
    onSave(mode === "add" ? { mode: "add", value: v } : { mode: "set", value: v }, next);
  };

  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "neg", "0", "."];
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          {nextLabel ? (
            <>
              <ItemButton className="flex-1" onClick={() => save(false)}>
                Save
              </ItemButton>
              <ItemButton variant="primary" className="flex-[2]" onClick={() => save(true)}>
                {nextLabel}
              </ItemButton>
            </>
          ) : (
            <ItemButton variant="primary" block onClick={() => save(false)}>
              Save
            </ItemButton>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {subtitle && <p className="-mt-1 text-xs text-[var(--text-muted)]">{subtitle}</p>}
        <div className="flex items-end justify-between gap-3 rounded-2xl bg-[var(--surface-2)] px-4 py-3">
          <div className="min-w-0">
            <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
              {mode === "add" ? `Now ${fmtScore(current ?? 0)} +` : current !== null ? `Was ${fmtScore(current)}` : "Score"}
            </div>
            <div aria-live="polite" className="truncate text-4xl font-bold tabular-nums text-[var(--text)]">
              {text || (mode === "set" ? fmtScore(current) : "0")}
            </div>
          </div>
          {mode === "add" && typed !== null && Number.isFinite(typed) && (
            <div className="text-right text-sm text-[var(--text-muted)]">
              = <span className="text-xl font-semibold tabular-nums text-[var(--item-accent)]">{fmtScore(result)}</span>
            </div>
          )}
          <button
            type="button"
            aria-label="Delete digit"
            onClick={() => press("back")}
            className="flex h-12 w-12 shrink-0 items-center justify-center self-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)] active:scale-95"
          >
            <Delete className="h-6 w-6" />
          </button>
        </div>
        {allowAdd && (
          <Segmented
            value={mode}
            onChange={setMode}
            options={[
              { value: "set", label: "Set" },
              { value: "add", label: "Add to it" },
            ]}
          />
        )}
        {!!options?.length && (
          <div className="flex flex-wrap gap-2">
            {options.map((o) => (
              <button
                key={o}
                type="button"
                onClick={() => onSave({ mode: "set", value: o }, !!nextLabel)}
                className="h-11 min-w-[56px] rounded-xl border border-[var(--item-accent)] bg-[color-mix(in_srgb,var(--item-accent)_10%,transparent)] px-3 text-base font-semibold tabular-nums text-[var(--text)] active:scale-95"
              >
                {o}
              </button>
            ))}
          </div>
        )}
        <div className="grid grid-cols-3 gap-2">
          {keys.map((k) => (
            <button
              key={k}
              type="button"
              aria-label={k === "." ? "Decimal point" : k === "neg" ? "Plus or minus" : k}
              onClick={() => press(k)}
              className={cn(
                "flex h-14 items-center justify-center rounded-2xl border border-[var(--border)] bg-[var(--surface)] text-2xl font-semibold tabular-nums text-[var(--text)] transition active:scale-95 active:bg-[var(--hover-strong)]",
                k === "neg" && "text-lg text-[var(--text-muted)]",
              )}
            >
              {k === "neg" ? "±" : k}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => onSave({ mode: "set", value: null }, false)}
          className="self-center text-xs text-[var(--text-muted)] underline-offset-2 hover:underline"
        >
          Clear this box
        </button>
      </div>
    </Sheet>
  );
}
