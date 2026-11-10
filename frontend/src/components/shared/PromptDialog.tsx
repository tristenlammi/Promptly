import { useEffect, useRef, useState, type ReactNode } from "react";
import { create } from "zustand";

import { cn } from "@/utils/cn";

import { Button } from "./Button";
import { Modal } from "./Modal";

/**
 * The small "name it" dialog (UI plan A5): a styled, promise-based
 * replacement for ``window.prompt()``. One text box, Enter to save, Escape
 * to cancel.
 *
 *   const name = await promptText({ title: "New album", label: "Album name" });
 *   if (name === null) return;          // cancelled
 *   await createAlbum(name);
 *
 *   const next = await promptText({
 *     title: "Rename",
 *     initialValue: file.name,
 *     selectStem: true,                  // selects "holiday" in "holiday.jpg"
 *     confirmLabel: "Rename",
 *     validate: (v) => (v.includes("/") ? "A name can't contain /" : null),
 *   });
 *
 * Resolves to the trimmed text, or ``null`` on Cancel / Escape / tap
 * outside. An empty box can't be submitted unless ``allowEmpty`` is set.
 * Works from anywhere (hooks or not, inside a Sheet or another dialog);
 * needs ``<PromptHost />`` mounted once at the app root (App.tsx does).
 *
 * For yes/no questions use ``confirm()`` from ./ConfirmDialog instead.
 */
export interface PromptOptions {
  /** Dialog heading, e.g. "New folder". */
  title: string;
  /** A line of help under the heading. */
  message?: ReactNode;
  /** Label above the box (also its accessible name). Defaults to the title. */
  label?: string;
  placeholder?: string;
  initialValue?: string;
  /** Primary button text. Default "Save". */
  confirmLabel?: string;
  /** Default "Cancel". */
  cancelLabel?: string;
  /** Return a message to block saving, or null when the text is fine. */
  validate?: (value: string) => string | null | undefined;
  /** Allow saving an empty box (resolves ""). Default false. */
  allowEmpty?: boolean;
  /** Select only the part before the last dot of ``initialValue`` (file names). */
  selectStem?: boolean;
  maxLength?: number;
  /** Several lines (a description, a note). Ctrl/Cmd+Enter saves. */
  multiline?: boolean;
  /** Keep the text as typed instead of trimming it. */
  noTrim?: boolean;
}

interface Pending extends PromptOptions {
  id: number;
  resolve: (value: string | null) => void;
}

interface PromptState {
  current: Pending | null;
  request: (opts: PromptOptions) => Promise<string | null>;
  settle: (value: string | null) => void;
}

let seq = 0;

const usePromptStore = create<PromptState>((set, get) => ({
  current: null,
  request: (opts) =>
    new Promise<string | null>((resolve) => {
      // One prompt at a time: a second one cancels the first.
      get().current?.resolve(null);
      set({ current: { ...opts, id: ++seq, resolve } });
    }),
  settle: (value) => {
    const cur = get().current;
    if (!cur) return;
    cur.resolve(value);
    set({ current: null });
  },
}));

/** Ask for one piece of text. See the comment at the top of this file. */
export function promptText(opts: PromptOptions): Promise<string | null> {
  return usePromptStore.getState().request(opts);
}

/** Single mounted host that renders whatever prompt is pending. */
export function PromptHost() {
  const current = usePromptStore((s) => s.current);
  const settle = usePromptStore((s) => s.settle);
  return (
    <Modal open={!!current} onClose={() => settle(null)} title={current?.title} description={undefined} widthClass="max-w-sm" layer="top">
      {current && <PromptForm key={current.id} opts={current} onDone={settle} />}
    </Modal>
  );
}

function PromptForm({ opts, onDone }: { opts: PromptOptions; onDone: (value: string | null) => void }) {
  const [value, setValue] = useState(opts.initialValue ?? "");
  const [touched, setTouched] = useState(false);
  const field = useRef<HTMLInputElement & HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.focus();
    const text = opts.initialValue ?? "";
    const dot = opts.selectStem ? text.lastIndexOf(".") : -1;
    try {
      el.setSelectionRange(0, dot > 0 ? dot : text.length);
    } catch {
      /* not a text field */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const out = opts.noTrim ? value : value.trim();
  const problem = !out && !opts.allowEmpty ? null : (opts.validate?.(out) ?? null);
  const canSave = (!!out || !!opts.allowEmpty) && !problem;

  const submit = () => {
    setTouched(true);
    if (canSave) onDone(out);
  };

  const fieldClass = cn(
    "w-full rounded-xl border bg-[var(--bg)] px-3 text-sm text-[var(--text)] outline-none transition",
    "placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]",
    problem && touched ? "border-[var(--danger)]" : "border-[var(--border)]",
  );
  const label = opts.label ?? opts.title;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="flex flex-col gap-3"
    >
      {opts.message && <p className="text-sm leading-relaxed text-[var(--text-muted)]">{opts.message}</p>}
      <label className="flex flex-col gap-1.5">
        <span className={cn("text-xs font-medium text-[var(--text-muted)]", !opts.label && "sr-only")}>{label}</span>
        {opts.multiline ? (
          <textarea
            ref={field}
            value={value}
            rows={4}
            maxLength={opts.maxLength}
            placeholder={opts.placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                submit();
              }
            }}
            className={cn(fieldClass, "resize-none py-2")}
          />
        ) : (
          <input
            ref={field}
            type="text"
            value={value}
            maxLength={opts.maxLength}
            placeholder={opts.placeholder}
            autoComplete="off"
            onChange={(e) => setValue(e.target.value)}
            className={cn(fieldClass, "h-10")}
          />
        )}
      </label>
      {/* Always present so a late message is announced. */}
      <p role="alert" className={cn("text-xs text-[var(--danger)]", !(problem && (touched || value !== (opts.initialValue ?? ""))) && "hidden")}>
        {problem}
      </p>
      <div className="flex items-center justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" size="sm" onClick={() => onDone(null)}>
          {opts.cancelLabel ?? "Cancel"}
        </Button>
        <Button type="submit" variant="primary" size="sm" disabled={!canSave}>
          {opts.confirmLabel ?? "Save"}
        </Button>
      </div>
    </form>
  );
}
