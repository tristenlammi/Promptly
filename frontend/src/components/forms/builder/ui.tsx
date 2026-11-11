import { forwardRef, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type TextareaHTMLAttributes } from "react";

import { usePopoverDismiss } from "@/hooks/usePopoverDismiss";
import { cn } from "@/utils/cn";

/** Small pieces the form builder shares. Colours come from the app's tokens
 *  so the builder chrome matches the rest of Promptly. */

export const fieldCls =
  "w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]";

export const iconBtnCls =
  "inline-flex h-9 min-w-9 items-center justify-center gap-1.5 rounded-md px-2 text-sm text-[var(--text)] transition hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-40";

/** An on/off switch with a visible label. */
export function Switch({
  checked,
  onChange,
  label,
  hint,
  disabled,
  className,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  const id = useRef(`sw-${Math.random().toString(36).slice(2)}`).current;
  return (
    <div className={cn("flex items-start gap-3", className)}>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={hint ? `${id}-hint` : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)] disabled:opacity-50",
          checked ? "bg-[var(--accent-strong)]" : "bg-[var(--text-muted)]/40"
        )}
      >
        <span
          aria-hidden="true"
          className={cn("inline-block h-5 w-5 rounded-full bg-white shadow transition", checked ? "translate-x-[22px]" : "translate-x-0.5")}
        />
      </button>
      <span className="min-w-0 flex-1">
        <label htmlFor={id} className={cn("block cursor-pointer text-sm text-[var(--text)]", disabled && "opacity-60")}>
          {label}
        </label>
        {hint && (
          <span id={`${id}-hint`} className="mt-0.5 block text-xs text-[var(--text-muted)]">
            {hint}
          </span>
        )}
      </span>
    </div>
  );
}

/** A textarea that grows with what's typed (titles and descriptions). */
export const AutoTextarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string }>(
  function AutoTextarea({ className, value, ...rest }, outer) {
    const ref = useRef<HTMLTextAreaElement | null>(null);
    useLayoutEffect(() => {
      const el = ref.current;
      if (!el) return;
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight + 2}px`;
    }, [value]);
    return (
      <textarea
        ref={(el) => {
          ref.current = el;
          if (typeof outer === "function") outer(el);
          else if (outer) outer.current = el;
        }}
        rows={1}
        value={value}
        className={cn("resize-none overflow-hidden", className)}
        {...rest}
      />
    );
  }
);

/** A menu behind a button ("…"). Items are buttons with role menuitem. */
export function Menu({
  label,
  icon,
  children,
  align = "right",
  up = false,
  buttonClassName,
}: {
  label: string;
  icon: ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
  up?: boolean;
  buttonClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  usePopoverDismiss(open, ref, () => setOpen(false));
  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLElement>("[role=menuitem]:not([disabled]), [role=menuitemcheckbox]")?.focus();
  }, [open]);
  const onKey = (e: React.KeyboardEvent) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>("[role^=menuitem]:not([disabled])") ?? []);
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      items[(i + 1) % items.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className={cn(iconBtnCls, buttonClassName)}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {icon}
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={label}
          onKeyDown={onKey}
          className={cn(
            "absolute z-40 min-w-[14rem] overflow-hidden rounded-card border border-[var(--border)] bg-[var(--surface)] py-1 text-[var(--text)] shadow-lg",
            align === "right" ? "right-0" : "left-0",
            up ? "bottom-10" : "top-10"
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  onClick,
  children,
  disabled,
  checked,
  danger,
}: {
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  /** A tick-able item ("Shuffle options"). */
  checked?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role={checked === undefined ? "menuitem" : "menuitemcheckbox"}
      aria-checked={checked === undefined ? undefined : checked}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex min-h-[40px] w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--hover)] focus:bg-[var(--hover)] focus:outline-none disabled:opacity-40",
        danger && "text-red-600 dark:text-red-400"
      )}
    >
      {checked !== undefined && (
        <span aria-hidden="true" className="w-4 text-[var(--accent-text)]">
          {checked ? "✓" : ""}
        </span>
      )}
      {children}
    </button>
  );
}

/** A labelled number box that allows "empty" (no limit). */
export function NumberBox({
  label,
  value,
  onChange,
  min,
  max,
  placeholder,
  className,
  step,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  min?: number;
  max?: number;
  placeholder?: string;
  className?: string;
  step?: number;
}) {
  const [text, setText] = useState(value === null ? "" : String(value));
  useEffect(() => {
    setText((t) => (t === "" && value === null ? t : Number(t) === value ? t : value === null ? "" : String(value)));
  }, [value]);
  return (
    <label className={cn("flex flex-col gap-1 text-xs text-[var(--text-muted)]", className)}>
      {label}
      <input
        type="number"
        inputMode="decimal"
        className={cn(fieldCls, "w-full")}
        value={text}
        min={min}
        max={max}
        step={step}
        placeholder={placeholder}
        onChange={(e) => {
          setText(e.target.value);
          const raw = e.target.value.trim();
          if (raw === "") return onChange(null);
          const n = Number(raw);
          if (!Number.isFinite(n)) return;
          onChange(n);
        }}
      />
    </label>
  );
}
